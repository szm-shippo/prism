import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/index/local-vector-store.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { LocalVectorStore } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

function storage(initial) {
  let saved = initial;
  let fail = false;
  return {
    load: async () => saved,
    save: async (state) => {
      if (fail) throw new Error('save failed');
      saved = structuredClone(state);
    },
    fail: (value) => { fail = value; },
  };
}

const entry = (chunkId, sourceId, values) => ({ chunkId, sourceId, values });

test('cosine Top-K ranks vectors and persists them across reopening', async () => {
  const backing = storage();
  const vectors = await LocalVectorStore.open(backing, 2);
  await vectors.put([
    entry('north', 'one', [0, 1]),
    entry('east', 'two', [1, 0]),
    entry('south', 'three', [0, -1]),
  ]);
  const reopened = await LocalVectorStore.open(backing, 2);
  const hits = await reopened.search([0, 1], 2);
  assert.deepEqual(hits.map((hit) => hit.chunkId), ['north', 'east']);
  assert.equal(hits[0].score, 1);
  assert.equal(hits[1].score, 0);
  assert.deepEqual(await reopened.search([0, 1], 0), []);
});

test('update, chunk deletion, source deletion and clear affect only their targets', async () => {
  const vectors = await LocalVectorStore.open(storage(), 2);
  await vectors.put([entry('a', 'one', [1, 0]), entry('b', 'one', [0, 1]), entry('c', 'two', [0, -1])]);
  await vectors.update([entry('a', 'one', [-1, 0])]);
  assert.equal((await vectors.search([-1, 0], 1))[0].chunkId, 'a');
  await vectors.delete('a');
  assert.deepEqual((await vectors.search([-1, 0], 5)).map((hit) => hit.chunkId).sort(), ['b', 'c']);
  await vectors.deleteBySource('one');
  assert.deepEqual((await vectors.search([0, -1], 5)).map((hit) => hit.chunkId), ['c']);
  await vectors.clear();
  assert.deepEqual(await vectors.search([0, -1], 5), []);
});

test('dimension mismatch, zero vectors, duplicate IDs and corrupt storage are rejected', async () => {
  const vectors = await LocalVectorStore.open(storage(), 2);
  await assert.rejects(vectors.put([entry('bad', 'one', [1])]), /2 dimensions/);
  await assert.rejects(vectors.put([entry('bad', 'one', [0, 0])]), /nonzero/);
  await assert.rejects(vectors.put([entry('bad', 'one', [Infinity, 1])]), /finite/);
  await assert.rejects(vectors.put([entry('same', 'one', [1, 0]), entry('same', 'one', [0, 1])]), /unique/);
  await assert.rejects(vectors.search([1], 1), /2 dimensions/);
  await assert.rejects(vectors.search([0, 0], 1), /nonzero/);
  await assert.rejects(vectors.search([1, 0], -1), /limit/);
  await assert.rejects(LocalVectorStore.open(storage({ dimensions: 3, entries: [] }), 2), /rebuild/);
  assert.deepEqual(await vectors.search([1, 0], 5), []);
});

test('failed persistence leaves the previous vector state available', async () => {
  const backing = storage();
  const vectors = await LocalVectorStore.open(backing, 2);
  await vectors.put([entry('a', 'one', [1, 0])]);
  backing.fail(true);
  await assert.rejects(vectors.update([entry('a', 'one', [0, 1])]), /save failed/);
  assert.equal((await vectors.search([1, 0], 1))[0].score, 1);
  assert.equal((await (await LocalVectorStore.open(backing, 2)).search([1, 0], 1))[0].score, 1);
});

test('store accepts vectors returned by the remote embedding provider contract', async () => {
  const { outputFiles: providerFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/obsidian/openai-embedding-provider.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false,
  });
  const module = { exports: {} };
  runInNewContext(providerFiles[0].text, {
    module, exports: module.exports, require: () => ({ requestUrl: () => { throw new Error('unexpected network'); } }),
  });
  const provider = new module.exports.OpenAIEmbeddingProvider('test-key', 'test-model', async () => ({
    status: 200, text: JSON.stringify({ data: [
      { index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] },
    ] }),
  }));
  const [first, second] = await provider.embedBatch(['first', 'second']);
  const vectors = await LocalVectorStore.open(storage(), first.length);
  await vectors.put([entry('first', 'one', first), entry('second', 'two', second)]);
  assert.equal((await vectors.search([1, 0], 1))[0].chunkId, 'first');
});
