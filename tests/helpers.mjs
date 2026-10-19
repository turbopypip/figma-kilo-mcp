import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { WebSocket } from 'ws';
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCTcAAAAASUVORK5CYII=';
export function fixture() {
  const text = { id: '2:1', type: 'TEXT', name: 'Заголовок', characters: 'Hello world',
    x: 12, y: 16, width: 100, height: 20, visible: true,
    getStyledTextSegments: (fields, start, end) => [{ start, end, characters: 'Hello world'.slice(start, end), fontSize: 16, fontName: { family: 'Inter', style: 'Regular' } }] };
  const frame = { id: '1:1', type: 'FRAME', name: '../../CON:Макет', x: 0, y: 0, width: 4000, height: 2000,
    absoluteBoundingBox: { x: 0, y: 0, width: 4000, height: 2000 }, visible: true, layoutMode: 'VERTICAL',
    itemSpacing: 16, paddingTop: 24, children: [text],
    exportAsync: async options => options.format === 'SVG' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') : Buffer.from(PNG, 'base64') };
  const nodes = new Map([[frame.id, frame], [text.id, text]]);
  const figma = { currentPage: { id: '0:1', name: 'Page', selection: [frame] },
    getNodeByIdAsync: async id => nodes.get(id) || null, base64Encode: data => Buffer.from(data).toString('base64'),
    showUI() {}, ui: { postMessage() {}, onmessage: undefined } };
  return { figma, frame, text, nodes };
}
export async function pair(port, secret, figma) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'auth', secret }));
  const [raw] = await ready;
  if (JSON.parse(raw).type !== 'ready') throw new Error('Pair failed');
  if (figma) {
    vm.runInNewContext(await readFile('plugin/code.js', 'utf8'), { figma, __html__: '', console, Uint8Array });
    figma.ui.postMessage = response => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response)); };
    ws.on('message', raw => void figma.ui.onmessage(JSON.parse(raw)));
    ws.on('close', () => void figma.ui.onmessage({ type: 'disconnect' }));
  }
  return ws;
}
