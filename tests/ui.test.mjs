import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
test('plugin UI authenticates, forwards requests, clears secret, rejects foreign messages', async () => {
  const html = await readFile('plugin/ui.html', 'utf8');
  const elements = Object.fromEntries(['status', 'secret', 'connect', 'disconnect'].map(id => [id, { value: '', textContent: '' }]));
  const sent = [], forwarded = [], sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { assert.equal(url, 'ws://127.0.0.1:3055'); sockets.push(this); }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const parent = { postMessage: data => forwarded.push(data.pluginMessage) }, window = {};
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    document: { getElementById: id => elements[id] }, WebSocket: Socket, parent, window
  });
  elements.secret.value = 'a'.repeat(64); elements.connect.onclick();
  const ws = sockets[0]; ws.onopen(); assert.equal(sent[0].secret, elements.secret.value);
  ws.onmessage({ data: '{"type":"ready"}' }); assert.equal(elements.secret.value, '');
  ws.onmessage({ data: '{"type":"request","id":"1","method":"get_selection"}' });
  assert.equal(forwarded.at(-1).method, 'get_selection');
  window.onmessage({ source: {}, data: { pluginMessage: { type: 'response', id: 'evil' } } });
  assert.equal(sent.length, 1);
  window.onmessage({ source: parent, data: { pluginMessage: { type: 'response', id: '1', result: {} } } });
  assert.equal(sent.at(-1).id, '1');
  elements.disconnect.onclick(); assert.equal(forwarded.at(-1).type, 'disconnect');
});
