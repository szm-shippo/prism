import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/index/exclusion-rules.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { parseExcludedPaths, isExcludedPath } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('file and folder exclusions match exact paths and descendants only', () => {
  const rules = parseExcludedPaths('Private/\nDraft.md\nPrivate/');
  assert.deepEqual(rules, ['Private', 'Draft.md']);
  assert.equal(isExcludedPath('Private/note.md', rules), true);
  assert.equal(isExcludedPath('Private/nested/note.md', rules), true);
  assert.equal(isExcludedPath('Draft.md', rules), true);
  assert.equal(isExcludedPath('PrivateOther/note.md', rules), false);
  assert.equal(isExcludedPath('draft.md', rules), false);
});

test('absolute, traversal, and malformed exclusion paths are rejected', () => {
  for (const path of ['/absolute.md', '../outside.md', 'a/../b.md', 'C:\\note.md', 'a//b.md']) {
    assert.throws(() => parseExcludedPaths(path), /Vault-relative/);
  }
});
