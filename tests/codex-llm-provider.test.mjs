import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/codex-llm-provider.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false,
});

function createProvider(responses) {
  const calls = [];
  const auth = {
    access: async () => ({ token: 'first-token', accountId: 'account-1' }),
    refreshAfterUnauthorized: async () => ({ token: 'next-token', accountId: 'account-1' }),
  };
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, crypto: { randomUUID: () => 'session-1' },
    require: () => ({ requestUrl: async (request) => {
      calls.push(request);
      return responses.shift();
    } }),
  });
  return { provider: new module.exports.CodexLLMProvider(auth, 'codex-model'), calls };
}

const query = { messages: [{ role: 'user', content: 'Question' }],
  context: [{ sourceId: 'source-1', chunkId: 'chunk-1', content: 'Vault evidence' }] };

test('Codex answer uses selected account and preserves citation context', async () => {
  const { provider, calls } = createProvider([{ status: 200,
    text: 'data: {"type":"response.output_text.delta","delta":"Answer [cite:chunk-1]"}\n\n' +
      'data: {"type":"response.completed"}\n\n' }]);
  assert.deepEqual(structuredClone(await provider.generate(query)), { content: 'Answer [cite:chunk-1]' });
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].headers.Authorization, 'Bearer first-token');
  assert.equal(calls[0].headers['ChatGPT-Account-Id'], 'account-1');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.match(body.input[0].content, /chunk-1/);
  assert.match(body.instructions, /untrusted/);
});

test('Codex answer refreshes once after unauthorized and does not fall back to API key', async () => {
  const { provider, calls } = createProvider([
    { status: 401, text: 'private note' },
    { status: 200, text: 'data: {"type":"response.output_text.delta","delta":"Done"}\n\ndata: {"type":"response.completed"}\n\n' },
  ]);
  assert.deepEqual(structuredClone(await provider.generate(query)), { content: 'Done' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, 'Bearer next-token');
  assert.equal(calls[1].url, calls[0].url);
});

test('Codex answer rejects incomplete stream and redacts provider failures', async () => {
  const unfinished = createProvider([{ status: 200,
    text: 'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n' }]);
  await assert.rejects(unfinished.provider.generate(query), (error) => error.code === 'unknown');
  const unavailable = createProvider([{ status: 500, text: 'private note and token' }]);
  await assert.rejects(unavailable.provider.generate(query), (error) => {
    assert.equal(error.code, 'unavailable');
    assert.doesNotMatch(error.message, /private note|token/);
    return true;
  });
});
