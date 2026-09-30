import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/index/markdown-chunker.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { chunkMarkdown } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('chunker splits at headings and retains source, content, location, and hashes', () => {
  const chunks = chunkMarkdown('source-1', 'Intro\n\n# First\nBody\n## Second\nMore');
  assert.deepEqual(chunks.map(({ content, location }) => ({ content, location })), [
    { content: 'Intro', location: { startLine: 1, endLine: 1 } },
    { content: '# First\nBody', location: { startLine: 3, endLine: 4 } },
    { content: '## Second\nMore', location: { startLine: 5, endLine: 6 } },
  ]);
  assert.ok(chunks.every(({ chunk_id, content_hash, source_id }) => chunk_id && content_hash && source_id === 'source-1'));
  assert.deepEqual(chunkMarkdown('source-1', 'Intro\n\n# First\nBody\n## Second\nMore'), chunks);
});

test('chunker does not split on headings inside fenced code', () => {
  const chunks = chunkMarkdown('source-1', '# First\n```md\n# Not a heading\n```\n# Second');
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].content, /Not a heading/);
});

test('chunker omits empty input and requires a source ID', () => {
  assert.deepEqual(chunkMarkdown('source-1', ' \n\n '), []);
  assert.throws(() => chunkMarkdown('', '# Heading'), /source ID/);
});
