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
  assert.equal(result.layout.css.width, '32px');
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
