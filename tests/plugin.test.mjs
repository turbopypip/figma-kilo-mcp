import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../dist/bridge.js';
import { pair, fixture } from './helpers.mjs';
const secret = 'b'.repeat(64);
async function setup(t) {
  const b = new Bridge(secret, 0); await b.ready; t.after(() => b.close());
  const f = fixture(); await pair(b.port, secret, f.figma); return { b, ...f };
}
test('context preserves layout and styled text, reports truncation, rereads edits', async t => {
  const { b, text } = await setup(t);
  const full = await b.request('get_design_context', {});
  assert.equal(full.node.layoutMode, 'VERTICAL');
  assert.equal(full.node.children[0].textSegments[0].fontSize, 16);
  assert.equal(full.truncated, false);
  for (const params of [{ depth: 0 }, { maxNodes: 1 }]) {
    const limited = await b.request('get_design_context', params);
    assert.equal(limited.truncated, true); assert.equal(limited.node.nextChildId, '2:1');
  }
  text.name = 'Changed';
  assert.equal((await b.request('get_design_context', { nodeId: '2:1' })).node.name, 'Changed');
});
test('empty selection, removed node and invalid limits give actionable errors', async t => {
  const { b, figma } = await setup(t); figma.currentPage.selection = [];
  assert.equal((await b.request('get_selection', {})).nodes.length, 0);
  await assert.rejects(b.request('get_design_context', {}), /Select exactly one/);
  await assert.rejects(b.request('get_design_context', { nodeId: 'missing' }), /no longer exists/);
  await assert.rejects(b.request('get_design_context', { depth: -1 }), /range/);
});
test('PNG scale bounded, oversize exports and complex trees rejected', async t => {
  const { b, frame } = await setup(t);
  const shot = await b.request('get_screenshot', { scale: 2 });
  assert.equal(shot.scale, 2048 / 4000);
  frame.exportAsync = async () => Buffer.alloc(3 * 1024 * 1024 + 1);
  await assert.rejects(b.request('get_screenshot', {}), /3 MiB/);
  frame.children = Array.from({ length: 1001 }, (_, i) => ({ id: `${i}:2`, type: 'RECTANGLE' }));
  await assert.rejects(b.request('get_screenshot', {}), /1000 nodes/);
});
test('text and property limits are explicit; inaccessible component is marked', async t => {
  const { b, text, frame } = await setup(t);
  text.characters = 'a'.repeat(9000);
  let result = await b.request('get_design_context', { nodeId: text.id });
  assert.equal(result.truncated, true); assert.equal(result.node.characters.length, 8000);
  frame.fills = [{ type: 'SOLID', noise: 'x'.repeat(110000) }];
  result = await b.request('get_design_context', {});
  assert.equal(result.node.propertiesTruncated, true); assert.equal(result.truncated, true);
  frame.type = 'INSTANCE'; delete frame.fills; frame.getMainComponentAsync = async () => null;
  result = await b.request('get_design_context', {});
  assert.match(result.node.mainComponent.unavailable, /inaccessible/);
});
