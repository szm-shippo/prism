import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/openai-embedding-provider.ts', import.meta.url))],
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
  const provider = new module.exports.OpenAIEmbeddingProvider('credential', 'embedding-model');
  return { provider, calls };
}

test('remote embedding sends text to the fixed endpoint and returns a vector', async () => {
  const { provider, calls } = providerWith({
    status: 200, text: JSON.stringify({ data: [{ index: 0, embedding: [0.25, -0.5] }] }),
  });
  assert.deepEqual(structuredClone(await provider.embed('日本語')), [0.25, -0.5]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
  assert.equal(calls[0].headers.Authorization, 'Bearer credential');
  assert.deepEqual(JSON.parse(calls[0].body), {
    model: 'embedding-model', input: ['日本語'], encoding_format: 'float',
  });
});

test('batch output follows input order and empty input makes no request', async () => {
  const { provider, calls } = providerWith({
    status: 200,
    text: JSON.stringify({ data: [
      { index: 1, embedding: [2, 3] }, { index: 0, embedding: [0, 1] },
    ] }),
  });
  assert.deepEqual(structuredClone(await provider.embedBatch([])), []);
  assert.deepEqual(structuredClone(await provider.embedBatch(['first', 'second'])), [[0, 1], [2, 3]]);
  assert.equal(calls.length, 1);
});

test('provider and transport failures expose safe, actionable errors', async () => {
  for (const [status, code] of [[401, 'authentication'], [429, 'rate_limit'], [503, 'unavailable']]) {
    const { provider } = providerWith({ status, text: 'credential and private Markdown' });
    await assert.rejects(provider.embed('private Markdown'), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /credential|private Markdown/);
      return true;
    });
  }
  const { provider } = providerWith(() => { throw new Error('credential and private Markdown'); });
  await assert.rejects(provider.embed('private Markdown'), /unavailable/);
});

test('malformed or incomplete vectors are rejected', async () => {
  for (const data of [
    [{ index: 0, embedding: [Number.NaN] }],
    [{ index: 1, embedding: [1] }],
    [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }],
  ]) {
    const { provider } = providerWith({ status: 200, text: JSON.stringify({ data }) });
    await assert.rejects(provider.embedBatch(['a', 'b']), /invalid response/);
  }
});
