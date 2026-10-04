import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/copilot-llm-provider.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false,
});

function loadProvider() {
  const module = { exports: {} };
  const sidecarLoads = [];
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    Error,
    AbortController,
    require(specifier) {
      if (specifier === 'obsidian') return { Platform: { isDesktopApp: false } };
      sidecarLoads.push(specifier);
      throw new Error('sidecar unavailable');
    },
  });
  return { ...module.exports, sidecarLoads };
}

const query = {
  messages: [{ role: 'system', content: 'Use the references.' }, { role: 'user', content: 'Question' }],
  context: [{ sourceId: 'source-1', chunkId: 'chunk-1', content: 'Vault evidence' }],
};

function providerWith(runtime, options = {}) {
  const { CopilotLLMProvider } = loadProvider();
  return new CopilotLLMProvider({
    getAccessToken: options.getAccessToken ?? (async () => 'oauth-access-token'),
    cliPath: 'C:\\Users\\test\\copilot.exe',
    modelId: options.modelId,
    sidecarPath: 'C:\\plugin\\copilot-sdk-runtime.cjs',
    isDesktop: options.isDesktop ?? (() => true),
    runtime,
  });
}

test('fresh OAuth users can load models before selecting one and disabled entries are filtered', async () => {
  const calls = [];
  const runtime = {
    async listModels(request) {
      calls.push(request);
      return [
        { id: 'one', name: 'One' },
        { id: 'disabled', name: 'Disabled', policy: { state: 'disabled' } },
        { id: ' ', name: 'Blank' },
      ];
    },
    async generate() { throw new Error('must not generate'); },
  };
  const provider = providerWith(runtime, { modelId: '' });
  assert.deepEqual(structuredClone(await provider.listModels()), [{ id: 'one', name: 'One' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'oauth-access-token');
  assert.equal(calls[0].cliPath, 'C:\\Users\\test\\copilot.exe');
  assert.ok(calls[0].signal instanceof AbortSignal);
  await assert.rejects(provider.generate(query), (error) => error.code === 'invalid_request');
});

test('generate forwards the configured model and current messages/context through the desktop runtime', async () => {
  const calls = [];
  const runtime = {
    async listModels() { return []; },
    async generate(request) {
      calls.push(request);
      return { content: 'Answer [cite:chunk-1]' };
    },
  };
  const provider = providerWith(runtime, { modelId: 'chosen-copilot-model' });
  assert.deepEqual(structuredClone(await provider.generate(query)), { content: 'Answer [cite:chunk-1]' });
  assert.equal(calls[0].modelId, 'chosen-copilot-model');
  assert.deepEqual(structuredClone(calls[0].messages), query.messages);
  assert.deepEqual(structuredClone(calls[0].context), query.context);
  assert.equal(calls[0].token, 'oauth-access-token');
  await provider.dispose();
  await assert.rejects(provider.listModels(), (error) => error.code === 'unavailable');
});

test('mobile gate runs before token retrieval or sidecar require', async () => {
  const { CopilotLLMProvider, sidecarLoads } = loadProvider();
  let tokenReads = 0;
  const provider = new CopilotLLMProvider({
    getAccessToken: async () => { tokenReads += 1; return 'token'; },
    cliPath: 'C:\\Users\\test\\copilot.exe',
    modelId: 'selected',
    sidecarPath: 'C:\\plugin\\copilot-sdk-runtime.cjs',
    isDesktop: () => false,
  });
  await assert.rejects(provider.listModels(), (error) => error.code === 'unavailable');
  assert.equal(tokenReads, 0);
  assert.deepEqual(sidecarLoads, []);
});

test('sidecar loads lazily only after Desktop auth; failure is safe and contains no path or credential', async () => {
  const { CopilotLLMProvider, sidecarLoads } = loadProvider();
  const provider = new CopilotLLMProvider({
    getAccessToken: async () => 'private-token',
    cliPath: 'C:\\Users\\test\\copilot.exe',
    modelId: 'selected',
    sidecarPath: 'C:\\private\\extension\\copilot-sdk-runtime.cjs',
    isDesktop: () => true,
  });
  await assert.rejects(provider.listModels(), (error) => {
    assert.equal(error.code, 'unavailable');
    assert.doesNotMatch(error.message, /private-token|private|extension/);
    return true;
  });
  assert.equal(sidecarLoads.length, 1);
});

test('cancel settles while OAuth token retrieval is pending and never starts SDK work', async () => {
  let tokenRead;
  const tokenPromise = new Promise((resolve) => { tokenRead = resolve; });
  let sdkCalls = 0;
  const provider = providerWith({
    async listModels() { sdkCalls += 1; return []; },
    async generate() { sdkCalls += 1; return { content: 'unexpected' }; },
  }, { getAccessToken: () => tokenPromise });
  const pending = provider.listModels();
  await new Promise((resolve) => setImmediate(resolve));
  await provider.cancel();
  await assert.rejects(pending, (error) => error.code === 'unknown');
  tokenRead('late-token');
  assert.equal(sdkCalls, 0);
  await provider.dispose();
});

test('structured SDK failures map to safe provider categories without leaking details', async () => {
  for (const [code, expected] of [
    ['authentication', 'authentication'], ['rate_limit', 'rate_limit'], ['quota', 'quota'],
    ['usage_limit', 'usage_limit'], ['context_limit', 'context_limit'], ['invalid_request', 'invalid_request'],
  ]) {
    const runtime = {
      async listModels() {
        const error = new Error('private provider details and secret');
        error.name = 'CopilotRuntimeError';
        error.code = code;
        throw error;
      },
      async generate() { throw new Error('unused'); },
    };
    const provider = providerWith(runtime);
    await assert.rejects(provider.listModels(), (error) => {
      assert.equal(error.code, expected);
      assert.doesNotMatch(error.message, /private provider|secret/);
      return true;
    });
  }
});

test('typed OAuth refresh failures keep transient categories without exposing response bodies', async () => {
  for (const code of ['authentication', 'rate_limit', 'unavailable']) {
    const runtime = { async listModels() { throw new Error('must not start'); }, async generate() { throw new Error('unused'); } };
    const provider = providerWith(runtime, {
      getAccessToken: async () => {
        const error = new Error('private HTTP body and access token');
        error.name = 'CopilotAuthError';
        error.code = code;
        throw error;
      },
    });
    await assert.rejects(provider.listModels(), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private HTTP|access token/);
      return true;
    });
  }
});
