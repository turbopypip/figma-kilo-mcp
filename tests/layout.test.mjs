import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLayout, enrichContext } from '../extension/layout.js';
const properties = fields => [{ section: 'properties-inspection-panel', fields: Object.entries(fields).map(([name, value]) => ({ name, value })) }];

test('real Banner Content labels produce flex CSS without inventing token values or fixed Fill/Hug dimensions', () => {
  const layout = parseLayout(properties({ Flow: 'Vertical', Width: 'Fill (1,904px)', Height: 'Hug (392px)', 'Padding—Top': 'Spacing/sp-xl', Gap: 'Spacing/sp-lg' }));
  assert.deepEqual(layout.css, { display: 'flex', 'flex-direction': 'column' });
  assert.deepEqual(layout.sizing.width, { mode: 'fill', measured: '1904px' });
  assert.deepEqual(layout.sizing.height, { mode: 'hug', measured: '392px' });
  assert.deepEqual(layout.unresolved.map(item => item.property), ['padding-top', 'gap']);
  assert.equal(layout.hints.length, 2);
  assert.equal(layout.complete, false);
});

test('numeric inspected lengths map to CSS and unknown fields remain explicit', () => {
  const layout = parseLayout(properties({ Flow: 'Horizontal', Width: '1,280px', Height: '100%', 'Padding—Left': '24px', Gap: 'Auto', 'New field': 'something' }));
  assert.equal(layout.css.width, '1280px');
  assert.equal(layout.css.height, '100%');
  assert.equal(layout.css['padding-left'], '24px');
  assert.equal(layout.css['justify-content'], 'space-between');
  assert.equal(layout.css['padding-right'], undefined);
  assert.equal(layout.unresolved[0].property, 'New field');
  assert.match(layout.cssText, /flex-direction: row;/);
  const context = enrichContext({ properties: properties({ Width: '10px' }), nodes: [{ id: 'child', properties: properties({ Width: '20px' }) }] });
  assert.equal(context.layout.css.width, '10px');
  assert.equal(context.nodes[0].layout.css.width, '20px');
});


test('explicit Fixed dimensions exposed by Figma become numeric CSS', () => {
  const layout = parseLayout(properties({ Width: 'Fixed (1,920px)', Height: 'Fixed (408px)' }));
  assert.equal(layout.css.width, '1920px');
  assert.equal(layout.css.height, '408px');
  assert.equal(layout.sizing.width.mode, 'fixed');
});

test('named font families are extracted without guessing unknown families', () => {
  assert.equal(parseLayout(properties({'Font family':'Inter'})).css['font-family'],'Inter');
  assert.equal(parseLayout(properties({'Font family':'Montserrat'})).css['font-family'],'Montserrat');
  assert.equal(parseLayout(properties({'Font family':'Mixed'})).css['font-family'],undefined);
});
