import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseVariables, mapContextVariables, variablesPath, loadVariables } from '../dist/variables.js';
const context = css => ({ layout: { css }, nodes: [{ layout: { css } }], traversal: { nextRequest: { afterNodeId: '1:2' } } });
test('matching uses category and actual value, preserves originals and continuation path', () => {
  const vars = parseVariables(':root { --mimir-space-xl: 24px; --mimir-space-2xl: 32px; --mimir-size-text-xl: 32px; }');
  const result = mapContextVariables(context({ 'padding-top': '32.0px', 'font-size': '32px', width: '32px' }), vars, 'C:\\Проект\\variables.scss');
  assert.equal(result.layout.css['padding-top'], 'var(--mimir-space-2xl)');
  assert.equal(result.layout.css['font-size'], 'var(--mimir-size-text-xl)');
  assert.equal(result.layout.css.width, 'var(--mimir-space-2xl)');
  assert.equal(result.layout.resolvedValues['padding-top'], '32.0px');
  assert.deepEqual(result.nodes[0].layout, result.layout);
  assert.equal(result.traversal.nextRequest.variablesFile, 'C:\\Проект\\variables.scss');
});
test('aliases resolve, cycles/duplicate declarations excluded and ambiguous matches stay numeric', () => {
  const vars = parseVariables(':root { --base: 32px; --mimir-space-a: var(--base); --mimir-space-b: 32px; --dup: 1px; --dup: 2px; --cycle: var(--cycle); }');
  assert.equal(vars.get('--mimir-space-a'), '32px');
  assert.equal(vars.has('--dup'), false); assert.equal(vars.has('--cycle'), false);
  const result = mapContextVariables(context({gap:'32px', padding:'44px'}), vars);
  assert.equal(result.layout.css.gap, '32px');
  assert.equal(result.layout.variableMatching[0].status, 'ambiguous');
  assert.equal(result.layout.variableMatching[1].status, 'not-found');
});
test('Windows drive/UNC paths and spaces accepted on Windows; foreign paths fail explicitly', () => {
  assert.equal(variablesPath('"C:\\Мой проект\\variables.scss"', 'win32'), 'C:\\Мой проект\\variables.scss');
  assert.equal(variablesPath('\\\\server\\share\\variables.scss', 'win32'), '\\\\server\\share\\variables.scss');
  assert.throws(() => variablesPath('C:\\site\\variables.scss', 'darwin'), /Windows/);
  assert.throws(() => variablesPath('variables.scss', 'win32'), /absolute/);
});
test('file values are refreshed on every request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'figma-vars-')), file = path.join(dir, 'variables.scss');
  try {
    await writeFile(file, ':root { --mimir-space-xl: 24px; }');
    assert.equal((await loadVariables(file)).get('--mimir-space-xl'), '24px');
    await writeFile(file, ':root { --mimir-space-xl: 28px; }');
    assert.equal((await loadVariables(file)).get('--mimir-space-xl'), '28px');
  } finally { await rm(dir, { recursive:true, force:true }); }
});
test('theme scopes and Sass imports are rejected instead of silently selecting a mode', () => {
  assert.throws(() => parseVariables('@media (dark) { :root { --mimir-space-xl: 24px; } }'), /flat/);
  assert.throws(() => parseVariables('@use "theme"; :root { --mimir-space-xl: 24px; }'), /flat/);
  const result = mapContextVariables(context({ gap: '32px' }), parseVariables(':root { --mimir-space-xl: 2rem; }'));
  assert.equal(result.layout.css.gap, '32px');
});

test('user policy: all dimensions and line height use spaces; shadows and layers stay literal', () => {
  const vars = parseVariables(`:root {
    --mimir-space-m:16px; --mimir-space-xl:24px; --button-height-ms:16px;
    --mimir-size-text-l:16px; --mimir-control-text-size-l:16px;
    --mimir-line-height-text-xl:1.5em; --mimir-container-width-xs:375px;
    --mimir-zindex-modal:1050; --mimir-box-shadow-active:0 0 2px #2355d7;
  }`);
  const result = mapContextVariables(context({width:'16px',height:'16px','max-width':'375px',
    padding:'16px 24px', 'font-size':'16px','line-height':'150%',
    'box-shadow':'0 0 2px #2355d7','z-index':'1050'}), vars).layout;
  assert.equal(result.css.width,'var(--mimir-space-m)');
  assert.equal(result.css.height,'var(--mimir-space-m)');
  assert.equal(result.css['max-width'],'375px');
  assert.equal(result.css.padding,'var(--mimir-space-m) var(--mimir-space-xl)');
  assert.equal(result.css['font-size'],'var(--mimir-size-text-l)');
  assert.equal(result.css['line-height'],'var(--mimir-space-xl)');
  assert.equal(result.css['box-shadow'],'0 0 2px #2355d7');
  assert.equal(result.css['z-index'],'1050');
  for (const value of ['1.5em','1.5']) {
    assert.equal(mapContextVariables(context({'font-size':'16px','line-height':value}),vars).layout.css['line-height'],'var(--mimir-space-xl)');
    assert.equal(mapContextVariables(context({'line-height':value}),vars).layout.css['line-height'],value);
  }
});

test('colors skip aliases and gos-znak, choose first literal, normalize hex/rgb and preserve alpha', () => {
  const vars = parseVariables(`:root {
    --sapphire-normal:var(--sapphire-100); --gos-znak-test:#2355d7;
    --sapphire-100:#2355d7; --another-blue:#2355d7;
    --white:#fff; --white-transparent:rgb(255 255 255 / 40%);
  }`);
  const c = context({color:'rgba(35, 85, 215, 1)','background-color':'#FFFFFF',fill:'rgba(255,255,255,0.4)',stroke:'rgba(35,85,215,0.8)'});
  c.properties = [{section:'colors-inspection-panel',text:'Colors\nrgba(35, 85, 215, 1)'}];
  const r = mapContextVariables(c,vars).layout;
  assert.equal(r.css.color,'var(--sapphire-100)');
  assert.equal(r.css['background-color'],'var(--white)');
  assert.equal(r.css.fill,'var(--white-transparent)');
  assert.equal(r.css.stroke,'rgba(35,85,215,0.8)');
  assert.deepEqual(r.variableMatching[0].candidates,['--sapphire-100','--another-blue']);
  assert.equal(r.colors[0].cssValue,'var(--sapphire-100)');
  const onlySummary = mapContextVariables({layout:{css:{}},properties:c.properties},vars).layout;
  assert.deepEqual(onlySummary.css,{});
  assert.equal(onlySummary.colors[0].cssValue,'var(--sapphire-100)');
});

test('font families accept bare family or equivalent stack, never drop a different fallback', () => {
  const vars = parseVariables(`:root {--mimir-font-inter:'Inter', sans-serif; --mimir-font-montserrat:'Montserrat', sans-serif;}`);
  for (const family of ['Inter','"Inter", sans-serif'])
    assert.equal(mapContextVariables(context({'font-family':family}),vars).layout.css['font-family'],'var(--mimir-font-inter)');
  assert.equal(mapContextVariables(context({'font-family':'Montserrat'}),vars).layout.css['font-family'],'var(--mimir-font-montserrat)');
  assert.equal(mapContextVariables(context({'font-family':'Inter, serif'}),vars).layout.css['font-family'],'Inter, serif');
});
