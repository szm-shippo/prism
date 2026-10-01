import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/index/retrieval-reranker.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { RetrievalReranker } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const candidates = [
  { chunkId: 'first', sourceId: 'one', score: 3 },
  { chunkId: 'second', sourceId: 'two', score: 2 },
  { chunkId: 'third', sourceId: 'three', score: 1 },
];

test('reranker moves query-relevant chunks ahead and returns Top-N without changing candidates', async () => {
  const content = new Map([['first', 'unrelated'], ['second', 'network timeout network timeout'], ['third', 'network']]);
  const reranker = new RetrievalReranker((id) => content.get(id));
  const result = await reranker.rerank('network timeout', candidates, 2);
  assert.deepEqual(result.map((candidate) => candidate.chunkId), ['second', 'third']);
  assert.equal(result[0].score, 2);
  assert.equal(candidates[0].chunkId, 'first');
});

test('missing content, scorer failure, or invalid scores restore original retrieval order', async () => {
  for (const reranker of [
    new RetrievalReranker(() => undefined),
    new RetrievalReranker(() => 'text', async () => { throw new Error('failed'); }),
    new RetrievalReranker(() => 'text', async () => [NaN]),
  ]) {
    assert.deepEqual(await reranker.rerank('query', candidates, 2), candidates.slice(0, 2));
  }
});

test('empty query and zero limit avoid scoring; invalid limit is rejected', async () => {
  const reranker = new RetrievalReranker(() => { throw new Error('unexpected'); });
  assert.deepEqual(await reranker.rerank('', candidates, 1), candidates.slice(0, 1));
  assert.deepEqual(await reranker.rerank('query', candidates, 0), []);
  await assert.rejects(reranker.rerank('query', candidates, -1), /limit/);
});
