import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/index/source-registry.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { SourceRegistry } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const scannerBuild = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/source-scanner.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { scanMarkdownSourcePaths } = await import(`data:text/javascript;base64,${Buffer.from(scannerBuild.outputFiles[0].contents).toString('base64')}`);

function storage(initial) {
  let saved = initial;
  return {
    load: async () => saved,
    save: async (records) => { saved = structuredClone(records); },
  };
}

const source = (path, content = '# Note') => ({ path, content, mtime: 100, size: content.length });

test('registry persists create, read, update and delete with stable source IDs', async () => {
  const backing = storage();
  const registry = await SourceRegistry.open(backing);
  const created = await registry.create(source('Notes/one.md'));
  assert.match(created.source_id, /^[\da-f-]{36}$/);
  assert.match(created.content_hash, /^[\da-f]{64}$/);
  assert.deepEqual(registry.getByPath('Notes/one.md'), created);
  assert.deepEqual((await SourceRegistry.open(backing)).getById(created.source_id), created);

  const updated = await registry.update(created.source_id, source('Moved/one.md', '# Changed'));
  assert.equal(updated.source_id, created.source_id);
  assert.notEqual(updated.content_hash, created.content_hash);
  assert.equal(registry.getByPath('Notes/one.md'), undefined);
  assert.equal(await registry.delete(created.source_id), true);
  assert.equal(await registry.delete(created.source_id), false);
  assert.deepEqual((await SourceRegistry.open(backing)).list(), []);
});

test('registry rejects duplicate paths, invalid paths, and corrupt persisted state', async () => {
  const registry = await SourceRegistry.open(storage());
  await registry.create(source('one.md'));
  await assert.rejects(registry.create(source('one.md')), /already exists/);
  await assert.rejects(registry.create(source('../escape.md')), /Vault-relative/);
  await assert.rejects(SourceRegistry.open(storage([{ source_id: 'bad' }])), /rebuild/);
});

test('failed persistence leaves the in-memory registry unchanged', async () => {
  const registry = await SourceRegistry.open({
    load: async () => undefined,
    save: async () => { throw new Error('disk full'); },
  });
  await assert.rejects(registry.create(source('one.md')), /disk full/);
  assert.deepEqual(registry.list(), []);
});

test('scanner paths can be registered as Vault-relative Markdown sources', async () => {
  const paths = scanMarkdownSourcePaths({
    getMarkdownFiles: () => [{ path: 'Notes/one.md' }, { path: '二番目.md' }],
  });
  const registry = await SourceRegistry.open(storage());
  for (const path of paths) await registry.create(source(path));
  assert.deepEqual(registry.list().map((record) => record.path), paths);
});

test('folder move rejects destination collisions without changing saved records', async () => {
  const registry = await SourceRegistry.open(storage());
  await registry.create(source('Old/one.md'));
  await registry.create(source('New/one.md'));
  const before = registry.list();
  await assert.rejects(registry.movePaths('Old', 'New'), /already exists/);
  assert.deepEqual(registry.list(), before);
});
