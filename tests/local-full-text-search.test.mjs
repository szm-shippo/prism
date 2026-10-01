import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/index/local-full-text-search.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { LocalFullTextSearch } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

function chunk(chunkId, sourceId, content) {
  return { chunk_id: chunkId, source_id: sourceId, content,
    content_hash: 'hash', location: { startLine: 1, endLine: 1 } };
}

function storage(initial) {
  let saved = initial;
  let fail = false;
  return {
    load: async () => saved,
    save: async (entries) => {
      if (fail) throw new Error('save failed');
      saved = structuredClone(entries);
    },
    fail: (value) => { fail = value; },
  };
}

test('search finds identifiers, numbers, error strings and Japanese text after reopening', async () => {
  const backing = storage();
  const index = await LocalFullTextSearch.open(backing);
  await index.index([
    chunk('a', 'source-1', 'ERR_CONNECTION_RESET 404。接続に失敗'),
    chunk('b', 'source-2', '404 not found'),
  ]);
  const reopened = await LocalFullTextSearch.open(backing);
  assert.deepEqual((await reopened.search('ERR_CONNECTION_RESET', 5)).map((hit) => hit.chunkId), ['a']);
  assert.deepEqual((await reopened.search('404', 5)).map((hit) => hit.chunkId), ['a', 'b']);
  assert.deepEqual((await reopened.search('接続に失敗', 5)).map((hit) => hit.chunkId), ['a']);
  assert.deepEqual(await reopened.search('missing', 5), []);
});

test('updating a chunk replaces its searchable text and deleting a source retains other results', async () => {
  const index = await LocalFullTextSearch.open(storage());
  await index.index([chunk('a', 'one', 'old term'), chunk('b', 'two', 'other term')]);
  await index.update([chunk('a', 'one', 'new term')]);
  assert.deepEqual(await index.search('old', 5), []);
  assert.equal((await index.search('new', 5))[0].chunkId, 'a');
  await index.deleteBySource('one');
  assert.deepEqual(await index.search('new', 5), []);
  assert.equal((await index.search('other', 5))[0].chunkId, 'b');
  await index.clear();
  assert.deepEqual(await index.search('other', 5), []);
});

test('failed storage writes do not change visible results and invalid storage is rejected', async () => {
  const backing = storage();
  const index = await LocalFullTextSearch.open(backing);
  await index.index([chunk('a', 'one', 'existing')]);
  backing.fail(true);
  await assert.rejects(index.update([chunk('a', 'one', 'replacement')]), /save failed/);
  assert.equal((await index.search('existing', 5)).length, 1);
  assert.deepEqual(await index.search('replacement', 5), []);
  assert.equal((await (await LocalFullTextSearch.open(backing)).search('existing', 5)).length, 1);
  await assert.rejects(LocalFullTextSearch.open(storage([{ chunkId: 'a' }])), /rebuild/);
});

test('duplicate IDs and invalid limits are rejected without changing the index', async () => {
  const index = await LocalFullTextSearch.open(storage());
  await assert.rejects(index.index([chunk('a', 'one', 'x'), chunk('a', 'one', 'y')]), /unique IDs/);
  assert.deepEqual(await index.search('x', 5), []);
  await assert.rejects(index.search('x', -1), /limit/);
  assert.deepEqual(await index.search(' ', 5), []);
});
