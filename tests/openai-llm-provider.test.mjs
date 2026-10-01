import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/openai-llm-provider.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['obsidian'],
  write: false,
});

function providerWith(response) {
  const calls = [];
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require: () => ({ requestUrl: async (request) => {
      calls.push(request);
      return typeof response === 'function' ? response(request) : response;
    } }),
  });
  return { provider: new module.exports.OpenAILLMProvider('credential', 'text-model'), calls };
}

const query = { messages: [{ role: 'user', content: 'What is this?' }], context: [] };

test('remote LLM sends query and untrusted reference context and extracts response text', async () => {
  const { provider, calls } = providerWith({
    status: 200,
    text: JSON.stringify({ output: [
      { type: 'reasoning' },
      { type: 'message', content: [{ type: 'output_text', text: 'First' }, { type: 'output_text', text: ' answer' }] },
    ] }),
  });
  assert.deepEqual(structuredClone(await provider.generate({
    ...query, context: [{ sourceId: 'source-1', content: 'A retrieved note' }],
  })), { content: 'First answer' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].headers.Authorization, 'Bearer credential');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, 'text-model');
  assert.equal(body.store, false);
  assert.equal(body.input[0].role, 'developer');
  assert.match(body.input[0].content, /untrusted data/);
  assert.deepEqual(body.input[1], {
    role: 'user', content: 'Reference material:\n[{"sourceId":"source-1","content":"A retrieved note"}]',
  });
  assert.deepEqual(body.input[2], query.messages[0]);
});

test('remote LLM preserves chunk IDs for source citations', async () => {
  const { provider, calls } = providerWith({ status: 200, text: JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer [cite:chunk-1]' }] }],
  }) });
  await provider.generate({ ...query, context: [{ sourceId: 'source-1', chunkId: 'chunk-1', content: 'Evidence' }] });
  const body = JSON.parse(calls[0].body);
  assert.match(body.input[1].content, /"chunkId":"chunk-1"/);
});

test('provider and transport errors do not reveal request or credentials', async () => {
  for (const [status, code] of [[401, 'authentication'], [429, 'rate_limit'], [500, 'unavailable']]) {
    const { provider } = providerWith({ status, text: 'credential and private note' });
    await assert.rejects(provider.generate(query), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /credential|private note/);
      return true;
    });
  }
  const { provider } = providerWith(() => { throw new Error('credential and private note'); });
  await assert.rejects(provider.generate(query), /unavailable/);
});

test('missing query and malformed API response fail safely', async () => {
  const { provider, calls } = providerWith({ status: 200, text: '{' });
  await assert.rejects(provider.generate({ messages: [], context: [] }), /rejected/);
  assert.equal(calls.length, 0);
  await assert.rejects(provider.generate(query), /request failed/);

  const malformed = providerWith({ status: 200, text: JSON.stringify({ output: [{ type: 'message', content: [] }] }) });
  await assert.rejects(malformed.provider.generate(query), /request failed/);
});
