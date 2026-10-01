import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(relativePath) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const { IndexUpdateOrchestrator } = await load('../src/core/index/index-update-orchestrator.ts');
const { ChunkRegistry } = await load('../src/core/index/chunk-registry.ts');
const { SourceRegistry } = await load('../src/core/index/source-registry.ts');
const { chunkMarkdown } = await load('../src/core/index/markdown-chunker.ts');
const { LocalFullTextSearch } = await load('../src/core/index/local-full-text-search.ts');
const { LocalVectorStore } = await load('../src/core/index/local-vector-store.ts');

function storage() {
  let saved;
  return { load: async () => saved, save: async (value) => { saved = structuredClone(value); } };
}

async function fixture() {
  const sources = await SourceRegistry.open(storage());
  const first = await sources.create({ path: 'first.md', content: '# First', mtime: 1, size: 7 });
  const second = await sources.create({ path: 'second.md', content: '# Second', mtime: 1, size: 8 });
  const chunks = await ChunkRegistry.open(storage(), sources);
  const fullText = await LocalFullTextSearch.open(storage());
  const vectors = await LocalVectorStore.open(storage(), 2);
  const embeddings = { embedBatch: async (texts) => texts.map((text) =>
    text.includes('First') || text.includes('Updated') ? [1, 0] : [0, 1]) };
  const updates = new IndexUpdateOrchestrator(chunks, fullText, embeddings,
    async (dimensions) => {
      if (dimensions !== undefined) assert.equal(dimensions, 2);
      return vectors;
    });
  return { first, second, chunks, fullText, vectors, embeddings, updates };
}

test('source create and modify synchronize both indexes without touching another source', async () => {
  const { first, second, chunks, fullText, vectors, updates } = await fixture();
  await chunks.put([...chunkMarkdown(first.source_id, '# First'),
    ...chunkMarkdown(second.source_id, '# Second')]);
  await updates.sync(first.source_id);
  await updates.sync(second.source_id);
  assert.equal((await fullText.search('First', 5))[0].sourceId, first.source_id);
  assert.equal((await vectors.search([1, 0], 1))[0].sourceId, first.source_id);
  await chunks.replaceBySource(first.source_id, chunkMarkdown(first.source_id, '# Updated'));
  await updates.sync(first.source_id);
  assert.deepEqual(await fullText.search('First', 5), []);
  assert.equal((await fullText.search('Updated', 5))[0].sourceId, first.source_id);
  assert.equal((await fullText.search('Second', 5))[0].sourceId, second.source_id);
  assert.equal((await vectors.search([0, 1], 1))[0].sourceId, second.source_id);
  await updates.delete(first.source_id);
  assert.deepEqual(await fullText.search('Updated', 5), []);
  assert.equal((await vectors.search([0, 1], 5)).length, 1);
});

test('embedding failure keeps current text searchable, removes stale vectors and retry repairs them', async () => {
  const { first, chunks, fullText, vectors, embeddings, updates } = await fixture();
  await chunks.put(chunkMarkdown(first.source_id, '# First'));
  await updates.sync(first.source_id);
  await chunks.replaceBySource(first.source_id, chunkMarkdown(first.source_id, '# Updated'));
  embeddings.embedBatch = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(updates.sync(first.source_id), /provider unavailable/);
  assert.deepEqual(await fullText.search('First', 5), []);
  assert.equal((await fullText.search('Updated', 5)).length, 1);
  assert.deepEqual(await vectors.search([1, 0], 5), []);
  embeddings.embedBatch = async () => [[1, 0]];
  await updates.sync(first.source_id);
  assert.deepEqual(await fullText.search('First', 5), []);
  assert.equal((await fullText.search('Updated', 5)).length, 1);
});

test('empty source removes old index records without requesting embeddings', async () => {
  const { first, chunks, fullText, vectors, embeddings, updates } = await fixture();
  await chunks.put(chunkMarkdown(first.source_id, '# First'));
  await updates.sync(first.source_id);
  await chunks.replaceBySource(first.source_id, []);
  embeddings.embedBatch = async () => { throw new Error('should not embed'); };
  await updates.sync(first.source_id);
  assert.deepEqual(await fullText.search('First', 5), []);
  assert.deepEqual(await vectors.search([1, 0], 5), []);
});

test('editing one chunk embeds only that chunk and leaves another source untouched', async () => {
  const { first, second, chunks, vectors, embeddings, updates } = await fixture();
  const sent = [];
  embeddings.embedBatch = async (texts) => {
    sent.push([...texts]);
    return texts.map(() => [1, 0]);
  };
  await chunks.put([...chunkMarkdown(first.source_id, '# First\n## Detail\nBody'),
    ...chunkMarkdown(second.source_id, '# Second')]);
  await updates.sync(first.source_id);
  await updates.sync(second.source_id);
  await chunks.replaceBySource(first.source_id, chunkMarkdown(first.source_id, '# First\n## Detail\nChanged'));
  await updates.sync(first.source_id);
  assert.deepEqual(sent.at(-1), ['## Detail\nChanged']);
  assert.equal(vectors.listBySource(first.source_id).length, 2);
  assert.equal(vectors.listBySource(second.source_id).length, 1);
  await updates.sync(first.source_id);
  assert.equal(sent.length, 3);
});
