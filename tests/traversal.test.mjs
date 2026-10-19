import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { figmaAction } from '../extension/dom.js';

// A genuinely virtual tree: only three rows exist at a time. Expanding changes
// indices; scrolling unmounts parents; selecting updates inspector properties.
function fixture({ interrupt = false, inspectorDelay = 0 } = {}) {
  const tree = [
    { id: 'root', level: 0, children: true },
    { id: 'group', level: 1, children: true, parent: 'root' },
    { id: 'a', level: 2, parent: 'group' },
    { id: 'b', level: 2, parent: 'group' },
    { id: 'c', level: 1, parent: 'root' },
    { id: 'outside', level: 0, children: true },
  ];
  const expanded = new Set(), selections = [], scrolls = [];
  let inspector = 'root', inspectorAt = 0;
  let selected = 'root', top = 0, now = 0, interrupted = false;
  const visible = () => tree.filter(item => !item.parent || (expanded.has(item.parent) && (item.parent !== 'group' || expanded.has('root'))));
  const body = {};
  const scroll = { parentElement: body, clientHeight: 60, get scrollHeight() { return visible().length * 20; },
    get scrollTop() { return top; }, set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - 60)); scrolls.push(top); } };
  const panel = { parentElement: scroll, clientHeight: 0 };
  const row = item => ({
    getAttribute: key => ({ 'data-fpl-selected-root': String(selected === item.id), 'aria-level': String(item.level), 'aria-expanded': item.children ? String(expanded.has(item.id)) : null })[key] ?? null,
    hasAttribute: key => key === 'aria-expanded' && item.children,
    querySelector: selector => selector.includes('-layers-panel-row') ? { getAttribute: () => `${item.id}-layers-panel-row`, innerText: item.id }
      : selector.includes('expand-caret') && item.children ? { click: () => expanded.add(item.id) } : null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    dispatchEvent() {}, click() { selected = item.id; inspectorAt = now + inspectorDelay; if (!inspectorDelay) inspector = selected; selections.push(item.id); },
    scrollIntoView({ block }) {
      const index = visible().findIndex(n => n.id === item.id);
      if (block === 'start' || index * 20 < top || index * 20 >= top + 60) scroll.scrollTop = index * 20;
    },
  });
  const label = value => ({ getClientRects: () => [1], getAttribute: key => key === 'aria-label' ? value : key === 'aria-selected' ? 'true' : null });
  const document = { body,
    querySelector: selector => selector.includes('objects-panel') ? panel : { getAttribute: () => 'Figma Design, 1 item selected' },
    querySelectorAll: selector => {
      if (selector === '[role="row"]') return visible().slice(Math.floor(top / 20), Math.floor(top / 20) + 3).map(row);
      if (selector === '[role="tab"]') return [label('Properties')];
      if (selector === 'button,[role="button"]') return [label(selected)];
      if (selector === '[data-testid$="inspection-panel"]') return [{ getClientRects: () => [1], getAttribute: () => 'properties-inspection-panel', innerText: `Width of ${inspector}`, querySelectorAll: selector => selector === 'button[aria-label]' ? [label(`Copy Width: ${inspector.length}px`)] : [] }];
      throw new Error(`Unexpected query: ${selector}`);
    },
  };
  const context = vm.createContext({ URL, location: { href: 'https://www.figma.com/design/file/Test' }, document,
    getComputedStyle: () => ({ overflowY: 'auto' }), PointerEvent: class {}, MouseEvent: class {},
    Date: { now: () => now }, setTimeout: (fn, ms) => { now += ms; if (now >= inspectorAt) inspector = selected; if (interrupt && selected === 'group' && !interrupted) { selected = 'outside'; interrupted = true; } fn(); },
  });
  const run = vm.runInContext(`(${figmaAction.toString()})`, context);
  return { run: params => run('get_design_context', params, 'file'), select: params => run('select_node', params, 'file'), expanded, selections, scrolls, get selected() { return selected; } };
}

test('walk expands nested groups, scrolls virtual rows, reads child properties and restores root without inspecting siblings', async () => {
  const f = fixture(); const { result, error } = await f.run({ depth: 4, maxNodes: 50 });
  assert.equal(error, undefined);
  assert.deepEqual(Array.from(result.nodes, n => n.id), ['root', 'group', 'a', 'b', 'c']);
  assert.equal(result.nodes[2].parentId, 'group');
  assert.equal(result.nodes[4].parentId, 'root');
  assert.equal(result.nodes[3].properties[0].text, 'Width of b');
  assert.equal(result.traversal.complete, true);
  assert.equal(result.traversal.restoredSelection, true);
  assert.equal(f.selected, 'root');
  assert.ok(f.scrolls.some(top => top > 0));
  assert.ok(!f.expanded.has('outside'));
  assert.ok(!f.selections.includes('outside'));
  // Revisit an unmounted discovered child, without manual scrolling.
  const second = await f.run({ nodeId: 'c', depth: 0, maxNodes: 5 });
  assert.equal(second.result.nodes[0].id, 'c');
});

test('node and depth limits expose continuation IDs rather than claiming completeness', async () => {
  const limited = await fixture().run({ depth: 4, maxNodes: 2 });
  assert.equal(limited.result.nodeCount, 2);
  assert.equal(limited.result.childrenTruncated, true);
  assert.equal(limited.result.traversal.pending[0].nodeId, 'a');
  const depth = await fixture().run({ depth: 1, maxNodes: 20 });
  assert.deepEqual(Array.from(depth.result.nodes, n => n.id), ['root', 'group', 'c']);
  assert.equal(depth.result.traversal.pending[0].nodeId, 'group');
});

test('user selection interrupts traversal and is not overwritten by root restoration', async () => {
  const f = fixture({ interrupt: true }); const { result } = await f.run({ depth: 4, maxNodes: 50 });
  assert.equal(result.traversal.complete, false);
  assert.equal(result.traversal.restoredSelection, false);
  assert.ok(result.traversal.reasons.some(reason => /Selection changed/.test(reason)));
  assert.equal(f.selected, 'outside');
});

test('continuation pages inspect remaining siblings with preserved parent IDs and no duplicate descendants', async () => {
  const f = fixture(), ids = [];
  let params = { depth: 4, maxNodes: 2 }, result;
  for (let i = 0; i < 6; i++) {
    ({ result } = await f.run(params));
    ids.push(...result.nodes.slice(1).map(n => n.id));
    if (!result.traversal.nextRequest) break;
    params = result.traversal.nextRequest;
  }
  assert.deepEqual(ids, ['group', 'a', 'b', 'c']);
  assert.equal(result.traversal.complete, true);
  assert.equal(result.nodes[1].parentId, 'root');
  assert.match((await f.run({ depth: 4, afterNodeId: 'missing' })).error, /Continuation layer/);
});


test('linked mounted node is selected directly without requiring URL navigation', async () => {
  const f = fixture();
  const result = await f.select({ nodeId: 'outside', mountedOnly: true });
  assert.equal(result.result.id, 'outside');
  assert.equal(f.selected, 'outside');
  assert.match((await f.select({ nodeId: 'a', mountedOnly: true })).error, /not found/);
});


test('adaptive inspection waits for delayed properties instead of attaching previous layer data', async () => {
  const f = fixture({ inspectorDelay: 96 });
  const { result } = await f.run({ depth: 4, maxNodes: 50 });
  assert.equal(result.nodes.length, 5);
  for (const node of result.nodes) assert.equal(node.properties[0].text, `Width of ${node.id}`);
  assert.equal(result.traversal.complete, true);
  assert.ok(result.traversal.elapsedMs > 0);
});
