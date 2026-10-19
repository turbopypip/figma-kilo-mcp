// Interactive smoke check. Uses the actual MCP transport; no model/API key is needed.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const evidencePrefix = process.env.FIGMA_KILO_CHECK_PREFIX === 'speed' ? 'speed' : 'browser';
const root = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'figma-browser-smoke', version: '0.2.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/index.js')],
  env: { ...process.env, FIGMA_KILO_CONFIG: process.env.FIGMA_KILO_CONFIG || path.join(root, '.local/config.json') }, stderr: 'inherit' });
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  await client.connect(transport);
  console.log('MCP ready. Connect the Chrome extension, select one small layer and open Properties.');
  console.log('PNG checks replace the clipboard; SVG uses native Export. Leave Figma focused while it runs.');
  let continuation = null, contextPage = 0;
  for (;;) {
    const command = await rl.question('Enter for full check, svg for SVG only, context [URL], continue, final <iconId>, or q: ');
    if (command.trim() === 'q') break;
    try {
      const contextOnly = command.trim().startsWith('context') || command.trim() === 'continue';
      const selectionLink = contextOnly ? command.trim().split(/\s+/)[1] : undefined;
      const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) throw new Error(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
        return result;
      };
      if (command.trim().startsWith('final ')) {
        const nodeId = command.trim().split(/\s+/)[1];
        const checks = [];
        const selection = JSON.parse((await call('get_selection')).content[0].text);
        checks.push({ tool: 'get_selection', nodes: selection.nodes });
        const context = JSON.parse((await call('get_design_context', { nodeId, depth: 0 })).content[0].text);
        if (context.node.id !== nodeId) throw new Error('Wrong context node');
        checks.push({ tool: 'get_design_context', nodeId, layout: context.layout });
        const screenshot = await call('get_screenshot', { nodeId });
        const image = screenshot.content.find(item => item.type === 'image');
        if (!image || image.mimeType !== 'image/png') throw new Error('No PNG screenshot');
        const out = path.join(root, 'artifacts'); await mkdir(out, { recursive: true });
        await writeFile(path.join(out, 'final-icon.png'), Buffer.from(image.data, 'base64'));
        checks.push({ tool: 'get_screenshot', nodeId, bytes: Buffer.from(image.data, 'base64').length });
        console.log('Selection, context and PNG screenshot passed.');
        for (const format of ['PNG', 'SVG']) {
          const exported = JSON.parse((await call('export_assets', { nodeIds: [nodeId], format })).content[0].text);
          if (exported.results.length !== 1 || exported.results[0].error || exported.results[0].nodeId !== nodeId) throw new Error(JSON.stringify(exported));
          checks.push({ tool: 'export_assets', format, ...exported.results[0] });
          console.log(`${format} disk export passed.`);
        }
        const invalid = await client.callTool({ name: 'get_design_context', arguments: { url: 'https://example.com/design/abc?node-id=1-2' } });
        if (!invalid.isError) throw new Error('Wrong-origin URL was accepted');
        checks.push({ check: 'wrong-origin URL rejected', passed: true });
        await writeFile(path.join(out, 'final-check.json'), JSON.stringify({ date: new Date().toISOString(), checks }, null, 2));
        console.log('PASS: all four MCP tools + both export formats + invalid URL rejection.');
        continue;
      }
      const selection = JSON.parse((await call('get_selection')).content[0].text);
      if (selection.nodes.length !== 1 && !selectionLink && command.trim() !== 'continue') throw new Error('Select exactly one visible layer.');
      const nodeId = selection.nodes[0]?.id;
      const context = JSON.parse((await call('get_design_context', command.trim() === 'continue' ? (continuation || (() => { throw new Error('No continuation pending'); })()) : { ...(selectionLink ? { url: selectionLink } : { nodeId }), depth: contextOnly ? 6 : 1, maxNodes: contextOnly ? 100 : 20 })).content[0].text);
      const out = path.join(root, 'artifacts'); await mkdir(out, { recursive: true });
      await writeFile(path.join(out, `${evidencePrefix}-context.json`), JSON.stringify({ selection, context }, null, 2));
      console.log(`Context received for ${context.node.id}; incomplete=${context.truncated}`);
      if (contextOnly) {
        continuation = context.traversal?.nextRequest;
        await writeFile(path.join(out, `${evidencePrefix}-context-page-${++contextPage}.json`), JSON.stringify(context, null, 2));
        console.log(JSON.stringify({ nodeCount: context.nodeCount, traversal: context.traversal, layout: context.layout }));
        continue;
      }
      if (command.trim() !== 'svg') {
        const screenshot = await call('get_screenshot', { nodeId });
        const image = screenshot.content.find(item => item.type === 'image');
        await writeFile(path.join(out, 'browser-screenshot.png'), Buffer.from(image.data, 'base64'));
        console.log('PNG received.');
      }
      const exported = JSON.parse((await call('export_assets', { nodeIds: [nodeId], format: 'SVG' })).content[0].text);
      if (exported.results.some(item => item.error) || !exported.results.length) throw new Error(JSON.stringify(exported));
      await writeFile(path.join(out, 'browser-check.json'), JSON.stringify({ date: new Date().toISOString(), nodeId, exported }, null, 2));
      console.log(`PASS: context, ${command.trim() === 'svg' ? '' : 'PNG, '}SVG through MCP. Evidence: ${out}`);
    } catch (error) { console.error(`NOT PASSED: ${error.message}`); }
  }
} finally { rl.close(); await client.close(); }
