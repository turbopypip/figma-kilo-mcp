import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Bridge } from '../dist/bridge.js';
import { pair, mockBrowser } from './helpers.mjs';
const secret = 'a'.repeat(64);
async function bridge(t, timeout = 1000) {
  const b = new Bridge(secret, 0, timeout); await b.ready; t.after(() => b.close()); return b;
}
test('unauthenticated peer rejected; reconnect works; duplicate cannot displace browser extension', async t => {
  const b = await bridge(t);
  await assert.rejects(b.request('get_selection', {}), /not connected/);
  const bad = new WebSocket(`ws://127.0.0.1:${b.port}`); await once(bad, 'open');
  const rejected = once(bad, 'close'); bad.send(JSON.stringify({ type: 'auth', secret: 'wrong' }));
  assert.equal((await rejected)[0], 1008);
  const peer = await pair(b.port, secret, mockBrowser);
  const duplicate = new WebSocket(`ws://127.0.0.1:${b.port}`); await once(duplicate, 'open');
  const dupClosed = once(duplicate, 'close'); duplicate.send(JSON.stringify({ type: 'auth', secret }));
  assert.equal((await dupClosed)[0], 1008);
  assert.equal((await b.request('get_selection', {})).nodes[0].id, '1:1');
  const closed = once(peer, 'close'); peer.close(); await closed;
  await pair(b.port, secret, mockBrowser);
  assert.equal((await b.request('get_selection', {})).total, 1);
});
test('busy, abort, timeout and disconnect release pending state', async t => {
  const b = await bridge(t, 100);
  let peer = await pair(b.port, secret);
  const request = b.request('get_selection', {});
  await assert.rejects(b.request('get_selection', {}), /busy/);
  await assert.rejects(request, /timed out/);
  await once(peer, 'close');
  peer = await pair(b.port, secret);
  const controller = new AbortController();
  const aborted = b.request('get_selection', {}, controller.signal); controller.abort();
  await assert.rejects(aborted, /cancelled/); await once(peer, 'close');
  peer = await pair(b.port, secret);
  const disconnected = b.request('get_selection', {}); peer.close();
  await assert.rejects(disconnected, /disconnected/);
});
test('port collision is reported', async t => {
  const b = await bridge(t); const collision = new Bridge(secret, b.port);
  await assert.rejects(collision.ready, /EADDRINUSE/); await collision.close();
});
test('malformed and oversized messages disconnect safely', async t => {
  const b = await bridge(t);
  let peer = await pair(b.port, secret);
  let closed = once(peer, 'close'); peer.send('{invalid'); assert.equal((await closed)[0], 1008);
  peer = await pair(b.port, secret);
  closed = once(peer, 'close'); peer.send('x'.repeat(6 * 1024 * 1024 + 1)); assert.equal((await closed)[0], 1009);
  await pair(b.port, secret, mockBrowser);
  assert.equal((await b.request('get_selection', {})).total, 1);
});
