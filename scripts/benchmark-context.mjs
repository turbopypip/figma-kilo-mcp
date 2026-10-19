// Real browser timing; no PNG export or clipboard operations.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadVariables, mapContextVariables } from '../dist/variables.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = process.env.FIGMA_KILO_CONFIG || path.join(root, '.local/config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const source = JSON.parse(await readFile(path.join(root, 'artifacts/variables-context-page-1.json'), 'utf8'));
// Reconstruct numeric CSS so this measures fresh matching, not already mapped var() strings.
const numeric = structuredClone(source);
for (const item of [numeric, ...(numeric.nodes || [])]) if (item.layout?.resolvedValues) item.layout.css = { ...item.layout.resolvedValues };
const samples = [];
for (let i = 0; i < 110; i++) {
  const start = performance.now();
  const vars = await loadVariables(config.variablesFile);
  mapContextVariables(numeric, vars);
  if (i >= 10) samples.push(performance.now() - start);
}
samples.sort((a,b) => a-b);
const report = { date: new Date().toISOString(), local: { nodes: numeric.nodeCount, iterations: samples.length,
  medianMs: samples[50], p95Ms: samples[94], maxMs: samples.at(-1), includes: 'read variables file, parse and map existing numeric context; excludes Chrome and transport' }, runs: [] };
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const output = path.join(root, 'artifacts/context-benchmark.json');
await writeFile(output, JSON.stringify(report, null, 2));
console.log('Local matching:', JSON.stringify(report.local));
const url = process.argv[2];
if (!url) { console.log('Pass selection URL to measure the live browser too.'); process.exit(0); }
const client = new Client({ name: 'context-benchmark', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root,'dist/index.js')], env: { ...process.env, FIGMA_KILO_CONFIG:configPath }, stderr:'inherit' });
const rl = createInterface({input:process.stdin,output:process.stdout});
try {
  await client.connect(transport);
  await rl.question('Connect the extension, leave Figma open, then press Enter: ');
  const preparationStart=performance.now();
  for (const nodeId of (process.argv[3] || '').split(',').filter(Boolean)) {
    const response=await client.callTool({name:'get_design_context',arguments:{nodeId,depth:1,maxNodes:50}});
    if(response.isError) throw new Error(response.content[0].text);
    console.log('Prepared ancestor',nodeId);
  }
  report.preparationMs=performance.now()-preparationStart;
  for (let run=0; run<2; run++) {
    const start=performance.now(), pages=[], ids=new Set();
    let args={url,depth:6,maxNodes:100}, complete=false;
    for (let page=0; page<10; page++) {
      const begin=performance.now();
      const response=await client.callTool({name:'get_design_context',arguments:args});
      if(response.isError) throw new Error(response.content[0].text);
      const context=JSON.parse(response.content[0].text);
      for(const node of context.nodes || []) ids.add(node.id);
      pages.push({wallMs:performance.now()-begin, traversalMs:context.traversal?.elapsedMs, nodes:context.nodeCount, rootCss:context.layout?.css, reasons:context.traversal?.reasons, pending:context.traversal?.pending});
      console.log(`Run ${run+1}, page ${page+1}:`, JSON.stringify(pages.at(-1)));
      if(!context.traversal?.nextRequest) { complete=!!context.traversal?.complete; break; }
      args=context.traversal.nextRequest;
    }
    report.runs.push({wallMs:performance.now()-start,uniqueNodes:ids.size,complete,pages});
    await writeFile(output,JSON.stringify(report,null,2));
  }
  console.log('RESULT', JSON.stringify(report));
} finally {rl.close();await client.close();}
