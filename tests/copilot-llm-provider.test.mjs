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

const expectedAccount = { host: 'github.com', login: 'copilot-user' };
const query = {
  messages: [{ role: 'system', content: 'Use the references.' }, { role: 'user', content: 'Question' }],
  context: [{ sourceId: 'source-1', chunkId: 'chunk-1', content: 'Vault evidence' }],
};

function providerWith(runtime, options = {}) {
  const { CopilotLLMProvider } = loadProvider();
  return new CopilotLLMProvider({
    ...(Object.hasOwn(options, 'expectedAccount') ? { expectedAccount: options.expectedAccount } : { expectedAccount }),
    modelId: options.modelId,
    sidecarPath: 'C:\\plugin\\copilot-sdk-runtime.cjs',
    isDesktop: options.isDesktop ?? (() => true),
    onAuthenticationFailure: options.onAuthenticationFailure,
    runtime,
  });
}

test('Check CLI login returns only the approved GitHub identity with no supplied token', async () => {
  const calls = [];
  const runtime = {
    async getAuthStatus(request) { calls.push(request); return expectedAccount; },
    async listModels() { throw new Error('must not list models'); },
    async generate() { throw new Error('must not generate'); },
  };
  const provider = providerWith(runtime, { expectedAccount: undefined });
  assert.deepEqual(structuredClone(await provider.checkAuth()), expectedAccount);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], 'cliPath'), false);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(Object.hasOwn(calls[0], 'token'), false);
  await provider.dispose();
});

test('model list requires and forwards the stored account identity without credentials', async () => {
  const calls = [];
  const runtime = {
    async getAuthStatus() { return expectedAccount; },
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
  assert.deepEqual(structuredClone(calls[0].expectedAccount), expectedAccount);
  assert.equal(Object.hasOwn(calls[0], 'cliPath'), false);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(Object.hasOwn(calls[0], 'token'), false);
  await assert.rejects(providerWith(runtime, { expectedAccount: undefined }).listModels(),
    (error) => error.code === 'authentication');
  await provider.dispose();
});

test('generate forwards only the selected model, current messages, context and expected account', async () => {
  const calls = [];
  const runtime = {
    async getAuthStatus() { return expectedAccount; },
    async listModels() { return []; },
    async generate(request) { calls.push(request); return { content: 'Answer [cite:chunk-1]' }; },
  };
  const provider = providerWith(runtime, { modelId: 'chosen-copilot-model' });
  assert.deepEqual(structuredClone(await provider.generate(query)), { content: 'Answer [cite:chunk-1]' });
  assert.equal(calls[0].modelId, 'chosen-copilot-model');
  assert.deepEqual(structuredClone(calls[0].messages), query.messages);
  assert.deepEqual(structuredClone(calls[0].context), query.context);
  assert.deepEqual(structuredClone(calls[0].expectedAccount), expectedAccount);
  assert.equal(Object.hasOwn(calls[0], 'token'), false);
  await provider.dispose();
  await assert.rejects(provider.listModels(), (error) => error.code === 'unavailable');
});

test('mobile gate runs before CLI status or sidecar loading', async () => {
  const { CopilotLLMProvider, sidecarLoads } = loadProvider();
  let runtimeCalls = 0;
  const provider = new CopilotLLMProvider({
    expectedAccount,
    modelId: 'selected',
    sidecarPath: 'C:\\plugin\\copilot-sdk-runtime.cjs',
    isDesktop: () => false,
    runtime: {
      async getAuthStatus() { runtimeCalls += 1; return expectedAccount; },
      async listModels() { runtimeCalls += 1; return []; },
      async generate() { runtimeCalls += 1; return { content: 'unexpected' }; },
    },
  });
  await assert.rejects(provider.listModels(), (error) => error.code === 'unavailable');
  await assert.rejects(provider.checkAuth(), (error) => error.code === 'unavailable');
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(sidecarLoads, []);
});

test('sidecar loads lazily only on Desktop and failure hides local path details', async () => {
  const { CopilotLLMProvider, sidecarLoads } = loadProvider();
  const provider = new CopilotLLMProvider({
    expectedAccount,
    modelId: 'selected',
    sidecarPath: 'C:\\private\\extension\\copilot-sdk-runtime.cjs',
    isDesktop: () => true,
  });
  await assert.rejects(provider.listModels(), (error) => {
    assert.equal(error.code, 'unavailable');
    assert.equal(error.stage, 'sidecar_load');
    assert.doesNotMatch(error.message, /private|extension/);
    return true;
  });
  assert.equal(sidecarLoads.length, 1);
});

test('provider preserves only whitelisted runtime stages and drops malformed diagnostic details', async () => {
  for (const [stage, expectedStage] of [
    ['cli_start', 'cli_start'],
    ['C:\\private\\token-file', undefined],
  ]) {
    const runtime = {
      async getAuthStatus() {
        const error = new Error('private stderr and token fixture');
        error.name = 'CopilotRuntimeError';
        error.code = 'unavailable';
        error.stage = stage;
        throw error;
      },
      async listModels() { return []; },
      async generate() { return { content: 'unused' }; },
    };
    const provider = providerWith(runtime);
    await assert.rejects(provider.checkAuth(), (error) => {
      assert.equal(error.code, 'unavailable');
      assert.equal(error.stage, expectedStage);
      assert.doesNotMatch(error.message, /private|stderr|token|file/);
      return true;
    });
  }
});

test('cancel settles a pending CLI identity check and blocks any later model or prompt work', async () => {
  let resolveAuth;
  const authPromise = new Promise((resolve) => { resolveAuth = resolve; });
  let listCalls = 0;
  let generateCalls = 0;
  const provider = providerWith({
    getAuthStatus: ({ signal }) => Promise.race([
      authPromise,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    ]),
    async listModels() { listCalls += 1; return []; },
    async generate() { generateCalls += 1; return { content: 'unexpected' }; },
  }, { expectedAccount: undefined });
  const pending = provider.checkAuth();
  await new Promise((resolve) => setImmediate(resolve));
  await provider.cancel();
  await assert.rejects(pending, (error) => error.code === 'unknown');
  resolveAuth(expectedAccount);
  assert.equal(listCalls, 0);
  assert.equal(generateCalls, 0);
  await provider.dispose();
});

test('authentication mismatch notifies Prism so it can clear the saved identity and catalog', async () => {
  let disconnected = 0;
  const runtime = {
    async getAuthStatus() { return expectedAccount; },
    async listModels() {
      const error = new Error('private auth details');
      error.name = 'CopilotRuntimeError';
      error.code = 'authentication';
      throw error;
    },
    async generate() { throw new Error('unused'); },
  };
  const provider = providerWith(runtime, { onAuthenticationFailure: () => { disconnected += 1; } });
  await assert.rejects(provider.listModels(), (error) => {
    assert.equal(error.code, 'authentication');
    assert.doesNotMatch(error.message, /private auth/);
    return true;
  });
  assert.equal(disconnected, 1);
});

test('known SDK failures map to safe provider categories without leaking details', async () => {
  for (const [code, expected] of [
    ['authentication', 'authentication'], ['rate_limit', 'rate_limit'], ['quota', 'quota'],
    ['usage_limit', 'usage_limit'], ['context_limit', 'context_limit'], ['invalid_request', 'invalid_request'],
  ]) {
    const runtime = {
      async getAuthStatus() { return expectedAccount; },
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
