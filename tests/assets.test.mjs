import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssetStore } from '../dist/assets.js';
import { PNG } from './helpers.mjs';
test('flat unique files stay in Unicode directory; invalid data never written', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'figma тест ')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await AssetStore.create(dir);
  const data = { nodeId: '1:1', name: '../../CON:C:\\secrets', format: 'PNG', data: PNG };
  const a = await store.write(data), b = await store.write(data);
  assert.notEqual(a.path, b.path); assert.equal(path.dirname(a.path), store.root);
  assert.deepEqual(await readFile(a.path), Buffer.from(PNG, 'base64'));
  await assert.rejects(store.write({ ...data, data: 'not base64' }));
  await assert.rejects(store.write({ ...data, data: Buffer.from('fake').toString('base64') }), /signature/);
  await assert.rejects(AssetStore.create('../relative'), /absolute/);
});
test('replaced output directory is rejected', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'figma-root-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await AssetStore.create(path.join(dir, 'assets'));
  await rename(store.root, path.join(dir, 'moved'));
  await symlink(path.join(dir, 'moved'), store.root);
  await assert.rejects(store.write({ nodeId: '1', name: 'x', format: 'PNG', data: PNG }), /replaced/);
});
test('large valid base64 is decoded without regex stack overflow; cap enforced', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'figma-large-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await AssetStore.create(dir);
  const bytes = Buffer.alloc(2 * 1024 * 1024); Buffer.from(PNG, 'base64').copy(bytes);
  const result = await store.write({ nodeId: '1', name: 'large', format: 'PNG', data: bytes.toString('base64') });
  assert.equal(result.bytes, bytes.length);
  await assert.rejects(store.write({ nodeId: '1', name: 'large', format: 'PNG', data: Buffer.alloc(4 * 1024 * 1024).toString('base64') }));
});
