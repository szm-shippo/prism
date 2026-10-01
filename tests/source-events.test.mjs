import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

async function bundle(relativePath, format = 'esm') {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    platform: 'node',
    format,
    external: ['obsidian'],
    write: false,
  });
  return outputFiles[0];
}

const registryBundle = await bundle('../src/core/index/source-registry.ts');
const { SourceRegistry } = await import(`data:text/javascript;base64,${Buffer.from(registryBundle.contents).toString('base64')}`);
const chunkRegistryBundle = await bundle('../src/core/index/chunk-registry.ts');
const { ChunkRegistry } = await import(`data:text/javascript;base64,${Buffer.from(chunkRegistryBundle.contents).toString('base64')}`);
const pipelineBundle = await bundle('../src/core/index/chunk-pipeline.ts');
const { ChunkPipeline } = await import(`data:text/javascript;base64,${Buffer.from(pipelineBundle.contents).toString('base64')}`);
const indexUpdatesBundle = await bundle('../src/core/index/index-update-orchestrator.ts');
const { IndexUpdateOrchestrator } = await import(`data:text/javascript;base64,${Buffer.from(indexUpdatesBundle.contents).toString('base64')}`);
const fullTextBundle = await bundle('../src/core/index/local-full-text-search.ts');
const { LocalFullTextSearch } = await import(`data:text/javascript;base64,${Buffer.from(fullTextBundle.contents).toString('base64')}`);
const vectorStoreBundle = await bundle('../src/core/index/local-vector-store.ts');
const { LocalVectorStore } = await import(`data:text/javascript;base64,${Buffer.from(vectorStoreBundle.contents).toString('base64')}`);

class TFile {
  constructor(path, content) {
    this.path = path;
    this.extension = path.split('.').at(-1);
    this.content = content;
    this.stat = { mtime: 20, size: content.length };
  }
}

const sourceEventsBundle = await bundle('../src/obsidian/source-events.ts', 'cjs');
const module = { exports: {} };
runInNewContext(sourceEventsBundle.text, {
  module,
  exports: module.exports,
  require: () => ({ TFile }),
  crypto: webcrypto,
  TextEncoder,
});
const { SourceEventHandler } = module.exports;

function makeRegistry() {
  let saved;
  return SourceRegistry.open({
    load: async () => saved,
    save: async (records) => { saved = structuredClone(records); },
  });
}

test('Vault events create, update, move and delete chunks without changing Markdown', async () => {
  const registry = await makeRegistry();
  let saved;
  const chunks = await ChunkRegistry.open({
    load: async () => saved,
    save: async (records) => { saved = structuredClone(records); },
  }, registry);
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry,
    new ChunkPipeline(registry, chunks));
  const file = new TFile('note.md', '# One\n## Old');
  await handler.create(file);
  const sourceId = registry.getByPath(file.path).source_id;
  assert.equal(chunks.listBySource(sourceId).length, 2);
  const oldChunkId = chunks.listBySource(sourceId)[1].chunk_id;
  file.content = '# One\n## New';
  file.stat.size = file.content.length;
  await handler.modify(file);
  assert.equal(chunks.get(oldChunkId), undefined);
  assert.equal(chunks.listBySource(sourceId)[1].content, '## New');
  file.path = 'moved.md';
  await handler.rename(file, 'note.md');
  assert.equal(chunks.provenance(chunks.listBySource(sourceId)[0].chunk_id).path, 'moved.md');
  await handler.delete(file);
  assert.deepEqual(chunks.listBySource(sourceId), []);
  assert.equal(file.content, '# One\n## New');
});

test('failed chunk persistence leaves Markdown untouched and a duplicate create retries', async () => {
  const registry = await makeRegistry();
  let fail = true;
  let saved;
  const chunks = await ChunkRegistry.open({
    load: async () => saved,
    save: async (records) => {
      if (fail) throw new Error('chunk save failed');
      saved = structuredClone(records);
    },
  }, registry);
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry,
    new ChunkPipeline(registry, chunks));
  const file = new TFile('retry.md', '# Retry');
  await assert.rejects(handler.create(file), /chunk save failed/);
  assert.equal(file.content, '# Retry');
  assert.equal(chunks.listBySource(registry.getByPath(file.path).source_id).length, 0);
  fail = false;
  await handler.create(file);
  assert.equal(chunks.listBySource(registry.getByPath(file.path).source_id).length, 1);
});

test('Vault events synchronize text and vector indexes without changing the source file', async () => {
  const registry = await makeRegistry();
  const chunks = await ChunkRegistry.open({ load: async () => undefined, save: async () => {} }, registry);
  const fullText = await LocalFullTextSearch.open({ load: async () => undefined, save: async () => {} });
  const vectors = await LocalVectorStore.open({ load: async () => undefined, save: async () => {} }, 2);
  const indexes = new IndexUpdateOrchestrator(chunks, fullText,
    { embedBatch: async (texts) => texts.map((text) => text.includes('New') ? [0, 1] : [1, 0]) },
    async () => vectors);
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry,
    new ChunkPipeline(registry, chunks), indexes);
  const file = new TFile('indexed.md', '# Old');
  await handler.create(file);
  assert.equal((await fullText.search('Old', 5)).length, 1);
  assert.equal((await vectors.search([1, 0], 5)).length, 1);
  file.content = '# New';
  file.stat.size = file.content.length;
  await handler.modify(file);
  assert.deepEqual(await fullText.search('Old', 5), []);
  assert.equal((await fullText.search('New', 5)).length, 1);
  await handler.delete(file);
  assert.deepEqual(await fullText.search('New', 5), []);
  assert.deepEqual(await vectors.search([0, 1], 5), []);
  assert.equal(file.content, '# New');
});

test('Markdown create event stores source metadata and ignores duplicate events', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const note = new TFile('Notes/new.md', '# New');
  await Promise.all([handler.create(note), handler.create(note)]);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.getByPath(note.path).mtime, 20);
  assert.equal(registry.getByPath(note.path).size, 5);
  assert.match(registry.getByPath(note.path).content_hash, /^[a-f0-9]{64}$/);
});

test('non-Markdown and folder create events do not read or register sources', async () => {
  const registry = await makeRegistry();
  let reads = 0;
  const handler = new SourceEventHandler({ read: async () => { reads += 1; return ''; } }, registry);
  await handler.create(new TFile('photo.png', 'binary'));
  await handler.create({ path: 'Folder' });
  assert.equal(reads, 0);
  assert.deepEqual(registry.list(), []);
});

test('failed Vault read leaves registry unchanged and does not block later events', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({
    read: async (file) => {
      if (file.path === 'bad.md') throw new Error('read failed');
      return file.content;
    },
  }, registry);
  await assert.rejects(handler.create(new TFile('bad.md', 'x')), /read failed/);
  await handler.create(new TFile('good.md', '# Good'));
  assert.equal(registry.list().length, 1);
});

test('Markdown modify detects changed content and updates source metadata', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const file = new TFile('note.md', '# Before');
  await handler.create(file);
  const original = registry.getByPath(file.path);
  file.content = '# After';
  file.stat = { mtime: 21, size: file.content.length };
  const result = await handler.modify(file);
  assert.deepEqual(structuredClone(result), { sourceId: original.source_id, contentChanged: true });
  assert.notEqual(registry.getByPath(file.path).content_hash, original.content_hash);
  assert.equal(registry.getByPath(file.path).mtime, 21);

  const repeated = await handler.modify(file);
  assert.deepEqual(structuredClone(repeated), { sourceId: original.source_id, contentChanged: false });
  file.stat.mtime = 22;
  assert.equal((await handler.modify(file)).contentChanged, false);
  assert.equal(registry.getByPath(file.path).mtime, 22);
});

test('modify ignores non-Markdown and unknown sources', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async () => { throw new Error('unexpected read'); } }, registry);
  assert.equal(await handler.modify(new TFile('photo.png', 'binary')), undefined);
  assert.equal(await handler.modify(new TFile('unknown.md', '# Unknown')), undefined);
});

test('renaming a Markdown file preserves its source ID and updates the path', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const file = new TFile('Notes/original.md', '# Note');
  await handler.create(file);
  const sourceId = registry.getByPath(file.path).source_id;
  file.path = 'Moved/renamed.md';
  file.extension = 'md';
  assert.deepEqual(structuredClone(await handler.rename(file, 'Notes/original.md')), [sourceId]);
  assert.equal(registry.getByPath('Notes/original.md'), undefined);
  assert.equal(registry.getByPath(file.path).source_id, sourceId);
  assert.deepEqual(structuredClone(await handler.rename(file, 'Notes/original.md')), []);
});

test('renaming a folder moves all contained Markdown paths without changing IDs', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({
    read: async (file) => file.content,
    getMarkdownFiles: () => [],
  }, registry);
  await handler.create(new TFile('Old/one.md', 'One'));
  await handler.create(new TFile('Old/Nested/two.md', 'Two'));
  const originalIds = registry.list().map((record) => record.source_id);
  const movedIds = await handler.rename({ path: 'New' }, 'Old');
  assert.deepEqual(structuredClone(movedIds), originalIds);
  assert.deepEqual(registry.list().map((record) => record.path), ['New/one.md', 'New/Nested/two.md']);
});

test('extension changes add or remove Markdown sources', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const file = new TFile('draft.txt', '# Draft');
  file.path = 'draft.md';
  file.extension = 'md';
  const [sourceId] = await handler.rename(file, 'draft.txt');
  assert.equal(registry.getByPath('draft.md').source_id, sourceId);
  file.path = 'draft.txt';
  file.extension = 'txt';
  assert.deepEqual(structuredClone(await handler.rename(file, 'draft.md')), [sourceId]);
  assert.equal(registry.getById(sourceId), undefined);
});

test('Markdown delete removes the source and returns its ID for downstream cleanup', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const file = new TFile('Notes/remove.md', 'Content');
  await handler.create(file);
  const sourceId = registry.getByPath(file.path).source_id;
  assert.deepEqual(structuredClone(await handler.delete(file)), [sourceId]);
  assert.equal(registry.getById(sourceId), undefined);
  assert.deepEqual(structuredClone(await handler.delete(file)), []);
});

test('folder delete removes descendants and ignores non-Markdown files', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  await handler.create(new TFile('Folder/a.md', 'A'));
  await handler.create(new TFile('Folder/Nested/b.md', 'B'));
  await handler.create(new TFile('Elsewhere/c.md', 'C'));
  const deleted = await handler.delete({ path: 'Folder' });
  assert.equal(deleted.length, 2);
  assert.deepEqual(registry.list().map((record) => record.path), ['Elsewhere/c.md']);
  assert.deepEqual(structuredClone(await handler.delete(new TFile('photo.png', 'binary'))), []);
});
