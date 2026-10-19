import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelectionLink } from '../extension/link.js';
test('selection links resolve ID and discard unrelated query parameters', () => {
  const result = parseSelectionLink('https://www.figma.com/design/abc/Title?node-id=1-22975&t=tracking', 'abc');
  assert.equal(result.nodeId, '1:22975');
  assert.equal(result.url, 'https://www.figma.com/design/abc/Title?node-id=1-22975');
});
test('selection link validation precedes navigation to wrong domains/files or ambiguous nodes', () => {
  for (const value of ['https://example.com/design/abc/x?node-id=1-2', 'https://www.figma.com/design/other/x?node-id=1-2', 'https://www.figma.com/design/abc/x', 'https://www.figma.com/proto/abc/x?node-id=1-2'])
    assert.throws(() => parseSelectionLink(value, 'abc'));
  assert.throws(() => parseSelectionLink('https://www.figma.com/design/abc/x?node-id=1-2', 'abc', '1:3'), /different/);
});
