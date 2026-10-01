import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/application/rag-pipeline.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { RagPipeline } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('pipeline retrieves, reranks, and fits complete chunks within the context budget', async () => {
  const calls = [];
  const candidates = [
    { chunkId: 'large', sourceId: 'source', score: 2 },
    { chunkId: 'small', sourceId: 'source', score: 1 },
  ];
  const chunks = new Map([
    ['large', { chunk_id: 'large', source_id: 'source', content: 'x'.repeat(200) }],
    ['small', { chunk_id: 'small', source_id: 'source', content: 'small fact' }],
  ]);
  const pipeline = new RagPipeline(
    async (query) => { calls.push(['vectorize', query]); return [1, 2]; },
    { retrieve: async (...args) => { calls.push(['retrieve', ...args]); return candidates; } },
    { rerank: async (...args) => { calls.push(['rerank', ...args]); return candidates; } },
    { get: (id) => chunks.get(id) },
    { answer: async (query, context) => {
      calls.push(['answer', query, context]);
      return { content: 'grounded', citations: [] };
    } },
    { candidates: 5, contextChunks: 2, contextTokens: 90 },
  );
  assert.deepEqual(await pipeline.answer('  question  '), { content: 'grounded', citations: [] });
  assert.deepEqual(calls[0], ['vectorize', 'question']);
  assert.deepEqual(calls[1], ['retrieve', 'question', [1, 2], 5]);
  assert.equal(calls[2][3], 2);
  assert.deepEqual(calls[3][2], [{ chunkId: 'small', sourceId: 'source', content: 'small fact' }]);
  assert.ok(new TextEncoder().encode(JSON.stringify(calls[3][2])).length <= 90);
});

test('pipeline rejects empty queries and conflicting candidate provenance', async () => {
  let vectorized = false;
  const pipeline = new RagPipeline(async () => { vectorized = true; return []; },
    { retrieve: async () => [{ chunkId: 'one', sourceId: 'wrong', score: 1 }] },
    { rerank: async (_query, candidates) => candidates },
    { get: () => ({ chunk_id: 'one', source_id: 'actual', content: 'Note' }) },
    { answer: async () => { throw new Error('unexpected answer'); } });
  await assert.rejects(pipeline.answer('  '), /non-empty query/);
  assert.equal(vectorized, false);
  await assert.rejects(pipeline.answer('question'), /conflicting source provenance/);
  assert.throws(() => new RagPipeline(async () => [], { retrieve: async () => [] },
    { rerank: async () => [] }, { get: () => undefined }, { answer: async () => ({}) },
    { candidates: 1, contextChunks: 0, contextTokens: 1 }), /Positive RAG/);
});
