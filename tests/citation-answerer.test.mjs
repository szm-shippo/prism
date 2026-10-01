import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/application/citation-answerer.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { CitationAnswerer } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const usedChunks = [
  { chunkId: 'chunk-one', sourceId: 'source-one', content: 'One' },
  { chunkId: 'chunk-two', sourceId: 'source-two', content: 'Two' },
];

test('citation answer retains chunk IDs and resolves only used evidence to current source locations', async () => {
  let request;
  const answerer = new CitationAnswerer({ generate: async (input) => {
    request = input;
    return { content: 'First [cite:chunk-one] and again [cite:chunk-one]. Second [cite:chunk-two].' };
  } }, { provenance: (id) => ({
    sourceId: id === 'chunk-one' ? 'source-one' : 'source-two',
    path: `${id}.md`, startLine: 2, endLine: 4,
  }) }, (path) => path === 'chunk-one.md');
  const result = await answerer.answer('Explain', usedChunks);
  assert.deepEqual(request.context, usedChunks);
  assert.match(request.messages[0].content, /exact chunkId/);
  assert.equal(result.content, 'First [^1] and again [^1]. Second .');
  assert.deepEqual(result.citations, [{
    chunkId: 'chunk-one', sourceId: 'source-one', path: 'chunk-one.md', startLine: 2, endLine: 4,
  }]);
});

test('unknown, deleted, and mismatched chunks never produce citations', async () => {
  const answerer = new CitationAnswerer({ generate: async () => ({
    content: 'Claim [cite:unknown] [cite:chunk-one] [cite:chunk-two]',
  }) }, { provenance: (id) => id === 'chunk-one'
    ? { sourceId: 'wrong-source', path: 'old.md', startLine: 1, endLine: 1 }
    : undefined }, () => true);
  assert.deepEqual(await answerer.answer('Explain', usedChunks), {
    content: 'Claim   ', citations: [],
  });
  await assert.rejects(answerer.answer('Explain', [usedChunks[0], usedChunks[0]]), /unique chunk IDs/);
});
