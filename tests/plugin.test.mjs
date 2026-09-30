import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('built plugin loads without errors and declares mobile support', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const bundle = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  const module = { exports: {} };

  class MockPlugin {
    async onload() {}
  }

  runInNewContext(bundle, {
    module,
    exports: module.exports,
    require(specifier) {
      assert.equal(specifier, 'obsidian');
      return { Plugin: MockPlugin };
    },
  });

  assert.equal(manifest.id, 'prism');
  assert.equal(manifest.isDesktopOnly, false);
  assert.equal(typeof module.exports.default, 'function');
  const plugin = new module.exports.default();
  assert.ok(plugin instanceof MockPlugin);
  await plugin.onload();
});
