import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(relativePath) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const { ChunkRegistry } = await load('../src/core/index/chunk-registry.ts');
const { SourceRegistry } = await load('../src/core/index/source-registry.ts');
const { chunkMarkdown } = await load('../src/core/index/markdown-chunker.ts');

function storage(initial) {
  let saved = initial;
  return {
    load: async () => saved,
    save: async (records) => { saved = structuredClone(records); },
  };
}

async function sourceRegistry() {
  const sources = await SourceRegistry.open(storage());
  const first = await sources.create({ path: 'one.md', content: '# One', mtime: 1, size: 5 });
  const second = await sources.create({ path: 'two.md', content: '# Two', mtime: 1, size: 5 });
  return { sources, first, second };
}

test('registry persists chunks and returns defensive copies by ID and source', async () => {
  const { sources, first, second } = await sourceRegistry();
  const backing = storage();
  const registry = await ChunkRegistry.open(backing, sources);
  const chunks = chunkMarkdown(first.source_id, '# One\nBody\n## Detail\nMore');
  const other = chunkMarkdown(second.source_id, '# Two');
  await registry.put([...chunks, ...other]);
  assert.deepEqual(registry.get(chunks[0].chunk_id), chunks[0]);
  assert.deepEqual(registry.listBySource(first.source_id), chunks);
  registry.get(chunks[0].chunk_id).location.startLine = 99;
  assert.equal(registry.get(chunks[0].chunk_id).location.startLine, 1);
  assert.deepEqual((await ChunkRegistry.open(backing, sources)).listBySource(first.source_id), chunks);
  assert.equal(await registry.deleteBySource(first.source_id), 2);
  assert.equal(registry.get(chunks[0].chunk_id), undefined);
  assert.deepEqual(registry.listBySource(second.source_id), other);
});

test('registry rejects unknown sources and corrupt stored data', async () => {
  const { sources } = await sourceRegistry();
  const registry = await ChunkRegistry.open(storage(), sources);
  await assert.rejects(registry.put(chunkMarkdown('unknown', '# Missing')), /registered source IDs/);
  assert.deepEqual(registry.listBySource('unknown'), []);
  await assert.rejects(ChunkRegistry.open(storage([{ chunk_id: 'bad' }]), sources), /rebuild/);
});

test('failed persistence leaves previous chunks available', async () => {
  const { sources, first } = await sourceRegistry();
  const registry = await ChunkRegistry.open({
    load: async () => undefined,
    save: async () => { throw new Error('disk full'); },
  }, sources);
  await assert.rejects(registry.put(chunkMarkdown(first.source_id, '# One')), /disk full/);
  assert.deepEqual(registry.listBySource(first.source_id), []);
});

test('replacing one source removes obsolete chunks and preserves unrelated chunks on failure', async () => {
  const { sources, first, second } = await sourceRegistry();
  let fail = false;
  let saved;
  const registry = await ChunkRegistry.open({
    load: async () => saved,
    save: async (chunks) => {
      if (fail) throw new Error('save failed');
      saved = structuredClone(chunks);
    },
  }, sources);
  const original = chunkMarkdown(first.source_id, '# One\n## Old');
  const unrelated = chunkMarkdown(second.source_id, '# Other');
  await registry.put([...original, ...unrelated]);
  const updated = chunkMarkdown(first.source_id, '# One\n## New');
  fail = true;
  await assert.rejects(registry.replaceBySource(first.source_id, updated), /save failed/);
  assert.deepEqual(registry.listBySource(first.source_id), original);
  fail = false;
  await registry.replaceBySource(first.source_id, updated);
  assert.deepEqual(registry.listBySource(first.source_id), updated);
  assert.deepEqual(registry.listBySource(second.source_id), unrelated);
  assert.deepEqual((await ChunkRegistry.open({ load: async () => saved }, sources)).listBySource(first.source_id), updated);
});

test('chunk provenance follows the source path after a move', async () => {
  const { sources, first } = await sourceRegistry();
  const registry = await ChunkRegistry.open(storage(), sources);
  const [chunk] = chunkMarkdown(first.source_id, '# One');
  await registry.put([chunk]);
  await sources.movePaths('one.md', 'Moved/one.md');
  assert.deepEqual(registry.provenance(chunk.chunk_id), {
    sourceId: first.source_id, path: 'Moved/one.md', startLine: 1, endLine: 1,
  });
  assert.equal(registry.get(chunk.chunk_id).chunk_id, chunk.chunk_id);
});

test('unchanged source chunks do not trigger a second persistence write', async () => {
  const { sources, first, second } = await sourceRegistry();
  let writes = 0;
  const registry = await ChunkRegistry.open({
    load: async () => undefined,
    save: async () => { writes += 1; },
  }, sources);
  const firstChunks = chunkMarkdown(first.source_id, '# First');
  await registry.put([...firstChunks, ...chunkMarkdown(second.source_id, '# Second')]);
  await registry.replaceBySource(first.source_id, firstChunks);
  assert.equal(writes, 1);
});
