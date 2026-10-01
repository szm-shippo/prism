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
