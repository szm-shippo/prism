import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boundaryViolations } from '../scripts/check-boundaries.mjs';

const sourceFile = (relativePath) => fileURLToPath(new URL(`../src/${relativePath}`, import.meta.url));

test('core can import its own modules and platform-neutral packages', () => {
  const source = "import type { Source } from '../index/source';\nimport { randomUUID } from 'node:crypto';";
  assert.deepEqual(boundaryViolations(sourceFile('core/application/example.ts'), source), []);
});

test('core rejects Obsidian API imports including dynamic and type imports', () => {
  const source = [
    "import { Plugin } from 'obsidian';",
    "type App = import('obsidian').App;",
    "async function load() { return import('obsidian'); }",
    "const api = require('obsidian');",
  ].join('\n');
  assert.equal(boundaryViolations(sourceFile('core/application/example.ts'), source).length, 4);
});

test('core rejects dependencies on the UI and Obsidian integration', () => {
  const source = "export { View } from '../../presentation/view';\nimport '../../obsidian/plugin';";
  assert.equal(boundaryViolations(sourceFile('core/application/example.ts'), source).length, 2);
});

test('index and provider modules reject application dependencies', () => {
  const source = "import { run } from '../application/run';";
  assert.equal(boundaryViolations(sourceFile('core/index/example.ts'), source).length, 1);
  assert.equal(boundaryViolations(sourceFile('core/provider/example.ts'), source).length, 1);
});

test('presentation stays independent of Obsidian APIs', () => {
  assert.equal(boundaryViolations(sourceFile('presentation/view.ts'), "import { Setting } from 'obsidian';").length, 1);
});
