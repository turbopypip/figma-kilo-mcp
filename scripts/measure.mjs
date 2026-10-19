import { fork } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, platform, release, arch, cpus, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { once } from 'node:events';
import { mockBrowser, pair } from '../tests/helpers.mjs';
const real = process.argv.includes('--real');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'figma-measure-'));
let configPath = process.env.FIGMA_KILO_CONFIG || path.join(root, '.local/config.json');
if (!real) {
  configPath = path.join(temp, 'config.json');
  await writeFile(configPath, JSON.stringify({ secret: 'benchmark-secret-'.repeat(4), port: 3056, assetDirectory: path.join(temp, 'assets') }));
}
const config = JSON.parse(await readFile(configPath, 'utf8'));
const child = fork(path.join(root, 'dist/index.js'), [], { silent: true,
  execArgv: ['--import', path.join(root, 'scripts/metrics-preload.mjs')],
  env: { ...process.env, FIGMA_KILO_CONFIG: configPath } });
const exited = once(child, 'exit');
child.stderr.pipe(process.stderr);
const pending = new Map(); let id = 0, buffer = '';
const accept = msg => { const resolve = pending.get(msg.id); if (resolve) { pending.delete(msg.id); resolve(msg); } };
child.stdout.on('data', chunk => {
  buffer += chunk;
  let pos;
  while ((pos = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1); if (line) accept(JSON.parse(line)); }
});
child.on('message', accept);
async function request(method, params = {}) {
  const requestId = ++id;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 65000);
    pending.set(requestId, response => { clearTimeout(timer); resolve(response); });
  });
  if (method === 'metrics') child.send({ type: 'metrics', id: requestId });
  else child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  return result;
}
const metrics = () => request('metrics');
const call = async (name, args = {}) => {
  const response = await request('tools/call', { name, arguments: args });
  if (response.error || response.result?.isError) throw new Error(JSON.stringify(response.error || response.result));
  return response.result;
};
const cpuPercent = (a, b, ms) => (b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / (ms * 10);
let peer;
try {
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'resource-probe', version: '1' } });
  if (init.error) throw new Error(JSON.stringify(init.error));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  if (real) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('Close Kilo first. Connect the Figma browser extension to this server, select one frame, then press Enter. '); rl.close();
  } else peer = await pair(config.port, config.secret, mockBrowser);
  const selection = JSON.parse((await call('get_selection')).content[0].text);
  console.error('Measuring 60 seconds idle (no Figma polling)…');
  const before = await metrics(), idleStart = performance.now();
  await new Promise(resolve => setTimeout(resolve, 60000));
  const after = await metrics(), idleMs = performance.now() - idleStart;
  const batches = [];
  for (let batch = 0; batch < 3; batch++) {
    const start = await metrics(), started = performance.now();
    let contextChars = 0, imageBytes = 0;
    for (let i = 0; i < 10; i++) {
      const context = await call('get_design_context'); contextChars = context.content[0].text.length;
      const screenshot = await call('get_screenshot'); imageBytes = Buffer.from(screenshot.content[0].data, 'base64').length;
    }
    const end = await metrics(), elapsedMs = performance.now() - started;
    batches.push({ requests: 20, elapsedMs, cpuPercent: cpuPercent(start, end, elapsedMs), rssMiB: end.memory.rss / 2 ** 20,
      peakRssMiB: end.usage.maxRSS / 1024, contextChars, imageBytes });
  }
  const report = { date: new Date().toISOString(), mode: real ? 'real Chrome DOM/clipboard' : 'mock browser adapter; real stdio MCP and WebSocket',
    os: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, ramGiB: totalmem() / 2 ** 30, node: process.version },
    selection, fixture: real ? null : { nodes: 2, png: 'mock 1x1 PNG' },
    idle: { seconds: idleMs / 1000, cpuPercent: cpuPercent(before, after, idleMs), rssMiB: after.memory.rss / 2 ** 20 }, batches,
    notes: ['Metrics cover server process only, including benchmark IPC listener.', 'maxRSS is cumulative process high-water mark, not a per-phase peak.', 'Chrome extension CPU/RAM and real render cost are not measured in mock mode.', 'Three batches are a smoke check, not proof of long-term memory stability.'] };
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  const target = path.join(root, 'artifacts', real ? 'resources-real.json' : 'resources-mock.json');
  await writeFile(target, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally {
  peer?.terminate(); child.stdin.end();
  const kill = setTimeout(() => child.kill(), 3000);
  await exited; clearTimeout(kill); await rm(temp, { recursive: true, force: true });
}
