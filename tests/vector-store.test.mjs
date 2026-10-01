import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/index/vector-store.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { validateVectorDimensions } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('vector validation rejects wrong length and non-finite coordinates', () => {
  assert.doesNotThrow(() => validateVectorDimensions([0, 1], 2));
  assert.throws(() => validateVectorDimensions([0], 2), /2 dimensions/);
  assert.throws(() => validateVectorDimensions([0, Infinity], 2), /finite vector/);
  assert.throws(() => validateVectorDimensions([], 0), /dimensions/);
});
