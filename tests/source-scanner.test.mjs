import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/source-scanner.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { scanMarkdownSourcePaths } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('scanner returns Vault-relative Markdown paths in Vault order', () => {
  const vault = { getMarkdownFiles: () => [{ path: 'Notes/one.md' }, { path: 'two.md' }] };
  assert.deepEqual(scanMarkdownSourcePaths(vault), ['Notes/one.md', 'two.md']);
});

test('scanner returns an empty list for a Vault without Markdown files', () => {
  assert.deepEqual(scanMarkdownSourcePaths({ getMarkdownFiles: () => [] }), []);
});
