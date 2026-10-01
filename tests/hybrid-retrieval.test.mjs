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

const { HybridRetrieval } = await load('../src/core/index/hybrid-retrieval.ts');
const { LocalFullTextSearch } = await load('../src/core/index/local-full-text-search.ts');
const { LocalVectorStore } = await load('../src/core/index/local-vector-store.ts');

test('retrieval merges real store results, deduplicates chunks and ranks shared hits first', async () => {
  const fullText = await LocalFullTextSearch.open({ load: async () => undefined, save: async () => {} });
  const vectors = await LocalVectorStore.open({ load: async () => undefined, save: async () => {} }, 2);
  await fullText.index([
    { chunk_id: 'shared', source_id: 'one', content: 'network error', content_hash: 'a', location: { startLine: 1, endLine: 1 } },
    { chunk_id: 'text-only', source_id: 'two', content: 'network error', content_hash: 'b', location: { startLine: 1, endLine: 1 } },
  ]);
  await vectors.put([
    { chunkId: 'shared', sourceId: 'one', values: [1, 0] },
    { chunkId: 'vector-only', sourceId: 'three', values: [0.8, 0.2] },
  ]);
  const retrieval = new HybridRetrieval(fullText, vectors);
  const results = await retrieval.retrieve('network', [1, 0], 3);
  assert.equal(results[0].chunkId, 'shared');
  assert.deepEqual(new Set(results.map((result) => result.chunkId)), new Set(['shared', 'text-only', 'vector-only']));
  assert.equal(results.length, 3);
  assert.deepEqual(await retrieval.retrieve('network', [1, 0], 0), []);
});

test('retrieval accepts one empty channel and rejects conflicting provenance', async () => {
  const retrieval = new HybridRetrieval(
    { search: async () => [] },
    { search: async () => [{ chunkId: 'vector', sourceId: 'one', score: 0.7 }] },
  );
  assert.deepEqual((await retrieval.retrieve('missing', [1], 2)).map((candidate) => candidate.chunkId), ['vector']);
  const conflict = new HybridRetrieval(
    { search: async () => [{ chunkId: 'same', sourceId: 'one', score: 2 }] },
    { search: async () => [{ chunkId: 'same', sourceId: 'other', score: 0.9 }] },
  );
  await assert.rejects(conflict.retrieve('term', [1], 2), /disagree/);
  await assert.rejects(retrieval.retrieve('term', [1], -1), /limit/);
});
