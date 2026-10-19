import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--assets' || !path.isAbsolute(args[1])) {
  console.error('Usage: npm run setup -- --assets "C:\\absolute\\project\\public\\figma"');
  process.exit(1);
}
const local = path.join(root, '.local');
await mkdir(local, { recursive: true, mode: 0o700 });
const configPath = path.join(local, 'config.json');
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (config) {
  if (path.resolve(config.assetDirectory) !== path.resolve(args[1])) throw new Error('Existing asset directory differs. Edit .local/config.json explicitly.');
} else {
  config = { secret: randomBytes(32).toString('hex'), port: 3055, assetDirectory: path.resolve(args[1]) };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
await writeFile(path.join(local, 'pairing.txt'), `Figma Kilo Bridge\nEndpoint: ws://127.0.0.1:${config.port}\nSecret: ${config.secret}\n`, { mode: 0o600 });
await writeFile(path.join(local, 'kilo.json'), JSON.stringify({ mcp: { figma: {
  type: 'local', command: [process.execPath, path.join(root, 'dist/index.js')], enabled: true,
  environment: { FIGMA_KILO_CONFIG: configPath }, timeout: 60000
} } }, null, 2) + '\n');
console.log(`Setup ready. Merge ${path.join(local, 'kilo.json')} into your Kilo config.\nPaste the secret from ${path.join(local, 'pairing.txt')} into the Figma plugin. Do not share these files.`);
