import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/core/provider/llm-provider.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { LLMProviderError } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

test('normalized provider errors expose safe messages and retryability', () => {
  const limited = new LLMProviderError('rate_limit');
  assert.equal(limited.code, 'rate_limit');
  assert.equal(limited.retryable, true);
  assert.match(limited.message, /rate limit/);
  assert.equal(new LLMProviderError('authentication').retryable, false);
  assert.equal(new LLMProviderError('unavailable').retryable, true);
});
