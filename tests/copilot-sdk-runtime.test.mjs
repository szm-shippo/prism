import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { suppressCopilotCliDiagnosticsPlugin } from '../scripts/copilot-sdk-stderr-plugin.mjs';

const testDirectory = await mkdtemp(join(tmpdir(), 'prism-copilot-runtime-tests-'));
const runtimeBundlePath = join(testDirectory, 'runtime.cjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/copilot-sdk-runtime.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['koffi'],
  outfile: runtimeBundlePath,
  plugins: [suppressCopilotCliDiagnosticsPlugin()],
});
const require = createRequire(import.meta.url);
const { createCopilotSdkRuntime } = require(runtimeBundlePath);
const cliPath = process.execPath;
const expectedAccount = { host: 'github.com', login: 'copilot-user' };
const messages = [
  { role: 'system', content: 'Use only supplied evidence.' },
  { role: 'user', content: 'First question' },
  { role: 'assistant', content: 'Prior response' },
  { role: 'user', content: 'Follow-up question' },
];
const context = [{ sourceId: 'source-1', chunkId: 'chunk-1', content: 'Indexed evidence' }];

function makeHarness(options = {}) {
  const calls = [];
  let fakeSession;
  const bindings = {
    stdioConnection(path) {
      calls.push(['stdio', path]);
      return { path };
    },
    createClient(clientOptions) {
      calls.push(['client', clientOptions]);
      const client = {
        async start() {
          calls.push(['start']);
          if (options.start) return options.start(clientOptions);
        },
        async getAuthStatus() {
          calls.push(['getAuthStatus']);
          return typeof options.authStatus === 'function'
            ? options.authStatus(clientOptions)
            : options.authStatus ?? { isAuthenticated: true, authType: 'user', host: 'https://github.com', login: 'copilot-user' };
        },
        async listModels() {
          calls.push(['listModels']);
          return options.models ?? [
            { id: 'model-one', name: 'Model One' },
            { id: 'model-disabled', name: 'Disabled', policy: { state: 'disabled' } },
          ];
        },
        async createSession(config) {
          calls.push(['createSession', config]);
          fakeSession = {
            sessionId: 'session-one',
            handlers: new Map(),
            on(event, handler) {
              this.handlers.set(event, handler);
              calls.push(['listen', event]);
              return () => calls.push(['unlisten', event]);
            },
            async sendAndWait(request, timeout) {
              calls.push(['sendAndWait', request, timeout]);
              if (options.sendAndWait) return options.sendAndWait(request, timeout, this);
              return { data: { content: 'Grounded answer' } };
            },
            async abort() { calls.push(['abortSession']); },
            async disconnect() { calls.push(['disconnect']); },
          };
          return fakeSession;
        },
        async deleteSession(id) { calls.push(['deleteSession', id]); },
        async stop() {
          calls.push(['stop']);
          await stat(clientOptions.workingDirectory);
          return options.stopErrors ?? [];
        },
        async forceStop() { calls.push(['forceStop']); },
      };
      return client;
    },
  };
  if (options.afterWorkspaceCreated) bindings.afterWorkspaceCreated = options.afterWorkspaceCreated;
  return { runtime: createCopilotSdkRuntime(bindings), calls, get session() { return fakeSession; } };
}

function clientOptions(calls) {
  return calls.filter(([kind]) => kind === 'client').map(([, options]) => options);
}

function errorCode(error) {
  assert.equal(error.name, 'CopilotRuntimeError');
  return error.code;
}

after(async () => rm(testDirectory, { recursive: true, force: true }));

test('SDK model listing rechecks the stored CLI user and strips ambient token and BYOK variables', async () => {
  const original = {
    provider: process.env.COPILOT_PROVIDER_BASE_URL,
    providersConfig: process.env.COPILOT_PROVIDERS_CONFIG,
    gh: process.env.GH_TOKEN,
    copilot: process.env.COPILOT_GITHUB_TOKEN,
    github: process.env.GITHUB_TOKEN,
    providerKey: process.env.COPILOT_PROVIDER_API_KEY,
    aws: process.env.AWS_ACCESS_KEY_ID,
  };
  process.env.COPILOT_PROVIDER_BASE_URL = 'https://ambient-provider.invalid';
  process.env.COPILOT_PROVIDERS_CONFIG = join(tmpdir(), 'ambient-copilot-providers.json');
  process.env.GH_TOKEN = 'ambient-auth-token';
  process.env.COPILOT_GITHUB_TOKEN = 'ambient-copilot-token';
  process.env.GITHUB_TOKEN = 'ambient-github-token';
  process.env.COPILOT_PROVIDER_API_KEY = 'ambient-provider-key';
  process.env.AWS_ACCESS_KEY_ID = 'ambient-secret';
  try {
    const checkedProviderRegistries = [];
    const harness = makeHarness({
      async start(config) {
        const fakeCli = "const fs=require('node:fs');const path=process.env.COPILOT_PROVIDERS_CONFIG;" +
          "const registry=JSON.parse(fs.readFileSync(path,'utf8'));" +
          "process.stdout.write(JSON.stringify({path,registry,userHome:process.env.USERPROFILE||process.env.HOME}));";
        const observed = spawnSync(process.execPath, ['-e', fakeCli], {
          cwd: config.workingDirectory, env: config.env, encoding: 'utf8',
        });
        assert.equal(observed.status, 0, observed.stderr);
        const childEnvironment = JSON.parse(observed.stdout);
        assert.equal(childEnvironment.path, config.env.COPILOT_PROVIDERS_CONFIG);
        assert.deepEqual(childEnvironment.registry, { providers: [], models: [] });
        assert.equal(childEnvironment.userHome, config.env.USERPROFILE ?? config.env.HOME);
        checkedProviderRegistries.push(childEnvironment.path);
      },
    });
    assert.deepEqual(await harness.runtime.listModels({ cliPath, expectedAccount }), [{ id: 'model-one', name: 'Model One' }]);
    assert.deepEqual(await harness.runtime.listModels({ cliPath, expectedAccount }), [{ id: 'model-one', name: 'Model One' }]);
    const configs = clientOptions(harness.calls);
    assert.equal(configs.length, 2, 'a new SDK client is used to refresh the model catalog');
    for (const config of configs) {
      assert.equal(config.mode, 'copilot-cli');
      assert.equal(config.useLoggedInUser, true);
      assert.equal(Object.hasOwn(config, 'gitHubToken'), false);
      assert.equal(Object.hasOwn(config, 'baseDirectory'), false);
      assert.equal(config.logLevel, 'none');
      assert.equal(config.env.COPILOT_PROVIDER_BASE_URL, undefined);
      assert.equal(config.env.COPILOT_PROVIDERS_CONFIG, join(dirname(config.workingDirectory), 'providers.json'));
      assert.equal(config.env.GH_TOKEN, undefined);
      assert.equal(config.env.COPILOT_GITHUB_TOKEN, undefined);
      assert.equal(config.env.GITHUB_TOKEN, undefined);
      assert.equal(config.env.COPILOT_PROVIDER_API_KEY, undefined);
      assert.equal(config.env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(config.env.COPILOT_HOME, undefined);
      assert.equal(config.env.COPILOT_RUNTIME_PROCESS_FILE_LOGGING, undefined);
      for (const name of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
        if (process.env[name] !== undefined) assert.equal(config.env[name], process.env[name]);
      }
      assert.ok(config.workingDirectory.startsWith(join(tmpdir(), 'prism-copilot-')));
      await assert.rejects(stat(config.workingDirectory));
      await assert.rejects(stat(config.env.COPILOT_PROVIDERS_CONFIG));
      const identityCheck = harness.calls.find(([kind]) => kind === 'getAuthStatus');
      assert.ok(identityCheck, 'auth status must be checked before listing models');
    }
    assert.equal(checkedProviderRegistries.length, 2, 'both CLI launches read the scoped empty BYOK registry before workspace cleanup');
  } finally {
    for (const [key, value] of Object.entries({
      COPILOT_PROVIDER_BASE_URL: original.provider,
      COPILOT_PROVIDERS_CONFIG: original.providersConfig,
      GH_TOKEN: original.gh,
      COPILOT_GITHUB_TOKEN: original.copilot,
      GITHUB_TOKEN: original.github,
      COPILOT_PROVIDER_API_KEY: original.providerKey,
      AWS_ACCESS_KEY_ID: original.aws,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('explicit CLI login check accepts a stored OAuth user identity and persists no credential', async () => {
  const harness = makeHarness();
  assert.deepEqual(await harness.runtime.getAuthStatus({ cliPath }), expectedAccount);
  const config = clientOptions(harness.calls)[0];
  assert.equal(config.mode, 'copilot-cli');
  assert.equal(config.useLoggedInUser, true);
  assert.equal(Object.hasOwn(config, 'gitHubToken'), false);
  assert.equal(Object.hasOwn(config, 'baseDirectory'), false);
  assert.equal(harness.calls.filter(([kind]) => kind === 'getAuthStatus').length, 1);
  assert.equal(harness.calls.some(([kind]) => kind === 'listModels' || kind === 'createSession'), false);
});

test('environment, GitHub CLI, BYOK, wrong-host, empty-login, and changed-user auth fail before any request', async () => {
  const rejectedStatuses = [
    { isAuthenticated: true, authType: 'env', host: 'github.com', login: 'copilot-user' },
    { isAuthenticated: true, authType: 'gh-cli', host: 'github.com', login: 'copilot-user' },
    { isAuthenticated: true, authType: 'api-key', host: 'github.com', login: 'copilot-user' },
    { isAuthenticated: true, authType: 'token', host: 'github.com', login: 'copilot-user' },
    { isAuthenticated: true, authType: 'hmac', host: 'github.com', login: 'copilot-user' },
    { isAuthenticated: false, authType: 'user', host: 'github.com', login: 'copilot-user' },
    { isAuthenticated: true, authType: 'user', host: 'https://ghe.example.com', login: 'copilot-user' },
    { isAuthenticated: true, authType: 'user', host: 'github.com', login: '' },
    { isAuthenticated: true, authType: 'user', host: 'github.com', login: 'different-user' },
  ];
  for (const authStatus of rejectedStatuses) {
    const harness = makeHarness({ authStatus });
    await assert.rejects(harness.runtime.listModels({ cliPath, expectedAccount }), (error) => {
      assert.equal(errorCode(error), 'authentication');
      return true;
    });
    await assert.rejects(harness.runtime.generate({ cliPath, expectedAccount, modelId: 'selected', messages, context }), (error) => {
      assert.equal(errorCode(error), 'authentication');
      return true;
    });
    const kinds = harness.calls.map(([kind]) => kind);
    assert.equal(kinds.filter((kind) => kind === 'getAuthStatus').length, 2);
    assert.equal(kinds.includes('listModels'), false);
    assert.equal(kinds.includes('createSession'), false);
    assert.equal(kinds.includes('sendAndWait'), false);
  }
});

test('generation sends only selected model, provided conversation and retrieved context, with all tools denied', async () => {
  const harness = makeHarness();
  const response = await harness.runtime.generate({ cliPath, expectedAccount, modelId: 'copilot-explicit-model', messages, context });
  assert.deepEqual(response, { content: 'Grounded answer' });
  const config = harness.calls.find(([kind]) => kind === 'createSession')[1];
  const send = harness.calls.find(([kind]) => kind === 'sendAndWait');
  assert.equal(config.model, 'copilot-explicit-model');
  assert.deepEqual(config.allowedModels, ['copilot-explicit-model']);
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.tools, []);
  assert.equal(config.skipCustomInstructions, true);
  assert.equal(config.enableConfigDiscovery, false);
  assert.equal(config.skipEmbeddingRetrieval, true);
  assert.equal(config.embeddingCacheStorage, 'in-memory');
  assert.equal(config.enableOnDemandInstructionDiscovery, false);
  assert.equal(config.enableSessionStore, false);
  assert.equal(config.enableSkills, false);
  assert.deepEqual(config.memory, { enabled: false });
  assert.equal(config.customAgentsLocalOnly, true);
  assert.equal(config.coauthorEnabled, false);
  assert.equal(config.enableSessionTelemetry, false);
  assert.ok(config.configDirectory.startsWith(join(tmpdir(), 'prism-copilot-')));
  assert.equal(config.enableFileHooks, false);
  assert.equal(config.enableHostGitOperations, false);
  assert.equal(config.systemMessage.mode, 'replace');
  assert.match(config.systemMessage.content, /Use only supplied evidence/);
  assert.equal(Object.hasOwn(config, 'onUserInputRequest'), false);
  assert.deepEqual(await config.onPermissionRequest(), { kind: 'reject', feedback: 'Prism Ask does not run tools.' });
  assert.deepEqual(await config.hooks.onPreToolUse({}), {
    permissionDecision: 'deny', permissionDecisionReason: 'Prism Ask does not run tools.',
  });
  assert.equal(send[2], 60_000);
  const prompt = JSON.parse(send[1].prompt.split('\n\n').at(-1));
  assert.deepEqual(prompt.map(({ role }) => role), ['user', 'assistant', 'user', 'user']);
  assert.equal(prompt.at(-1).content, 'Follow-up question');
  assert.match(prompt.at(-2).content, /chunk-1/);
  assert.match(prompt.at(-2).content, /Indexed evidence/);
  const calls = harness.calls.map(([kind]) => kind);
  assert.ok(calls.indexOf('getAuthStatus') < calls.indexOf('createSession'));
  assert.ok(calls.indexOf('createSession') < calls.indexOf('sendAndWait'));
  assert.ok(calls.indexOf('disconnect') < calls.indexOf('deleteSession'));
  assert.ok(calls.indexOf('deleteSession') < calls.indexOf('stop'));
  assert.ok(calls.indexOf('stop') < calls.indexOf('forceStop') || !calls.includes('forceStop'));
  await assert.rejects(stat(config.configDirectory));
  await assert.rejects(stat(config.workingDirectory));
});

test('known SDK error categories become fixed safe errors and no partial answer escapes', async () => {
  const harness = makeHarness({
    sendAndWait(_request, _timeout, session) {
      session.handlers.get('session.error')({ data: { errorType: 'quota', message: 'private response payload and credential' } });
      throw new Error('private response payload and credential');
    },
  });
  await assert.rejects(harness.runtime.generate({ cliPath, expectedAccount, modelId: 'selected', messages, context }), (error) => {
    assert.equal(errorCode(error), 'quota');
    assert.doesNotMatch(error.message, /private response|credential/);
    return true;
  });
  assert.ok(harness.calls.some(([kind]) => kind === 'deleteSession'));
});

test('output-limit finish reason is preserved as incomplete and empty output is rejected', async () => {
  const limited = makeHarness({
    sendAndWait(_request, _timeout, session) {
      session.handlers.get('assistant.usage')({ data: { finishReason: 'length' } });
      return { data: { content: 'Partial answer' } };
    },
  });
  assert.deepEqual(await limited.runtime.generate({ cliPath, expectedAccount, modelId: 'selected', messages, context }), {
    content: 'Partial answer', incompleteReason: 'output_limit',
  });
  const empty = makeHarness({ sendAndWait: async () => ({ data: { content: '  ' } }) });
  await assert.rejects(empty.runtime.generate({ cliPath, expectedAccount, modelId: 'selected', messages, context }), (error) => {
    assert.equal(errorCode(error), 'unknown');
    return true;
  });
});

test('send timeout aborts the session before it is deleted and removed', async () => {
  const harness = makeHarness({ sendAndWait: async () => { throw new Error('Timeout after 60000ms waiting for session.idle'); } });
  await assert.rejects(harness.runtime.generate({ cliPath, expectedAccount, modelId: 'selected', messages, context }), (error) => {
    assert.equal(errorCode(error), 'unavailable');
    return true;
  });
  const kinds = harness.calls.map(([kind]) => kind);
  assert.ok(kinds.indexOf('abortSession') < kinds.indexOf('disconnect'));
  assert.ok(kinds.indexOf('deleteSession') < kinds.indexOf('stop'));
  const workingDirectory = clientOptions(harness.calls)[0].workingDirectory;
  await assert.rejects(stat(workingDirectory));
});

test('abort during SDK startup returns promptly, stops the client and removes its owned workspace', async () => {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const harness = makeHarness({ start: async () => { markStarted(); return new Promise(() => {}); } });
  const controller = new AbortController();
  const pending = harness.runtime.listModels({ cliPath, expectedAccount, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(errorCode(error), 'unknown');
    return true;
  });
  assert.ok(harness.calls.some(([kind]) => kind === 'stop'));
  const workingDirectory = clientOptions(harness.calls)[0].workingDirectory;
  await assert.rejects(stat(workingDirectory));
});

test('abort while the temporary workspace is being created is handled and cleaned without a client', async () => {
  let releaseWorkspace;
  let markWorkspaceCreated;
  let isolatedWorkspace;
  const workspaceReady = new Promise((resolve) => { markWorkspaceCreated = resolve; });
  const workspaceGate = new Promise((resolve) => { releaseWorkspace = resolve; });
  const harness = makeHarness({
    async afterWorkspaceCreated(workspace) {
      isolatedWorkspace = workspace;
      markWorkspaceCreated();
      await workspaceGate;
    },
  });
  const controller = new AbortController();
  const pending = harness.runtime.listModels({ cliPath, expectedAccount, signal: controller.signal });
  await workspaceReady;
  controller.abort();
  releaseWorkspace();
  await assert.rejects(pending, (error) => errorCode(error) === 'unknown');
  assert.equal(clientOptions(harness.calls).length, 0);
  await assert.rejects(stat(isolatedWorkspace.root));
});

test('production sidecar loads without node_modules and suppresses SDK stderr and process file logging', async () => {
  const sidecar = new URL('../target/copilot-sdk-runtime.cjs', import.meta.url);
  const source = await readFile(sidecar, 'utf8');
  assert.doesNotMatch(source, /\[CLI subprocess\]/);
  assert.doesNotMatch(source, /COPILOT_RUNTIME_PROCESS_FILE_LOGGING/);
  const isolatedDirectory = await mkdtemp(join(tmpdir(), 'prism-copilot-sidecar-smoke-'));
  try {
    const isolatedSidecar = join(isolatedDirectory, 'copilot-sdk-runtime.cjs');
    await copyFile(fileURLToPath(sidecar), isolatedSidecar);
    const smoke = spawnSync(process.execPath, ['-e',
      "const r=require(process.argv[1]).copilotSdkRuntime; if(typeof r?.getAuthStatus!=='function'||typeof r?.listModels!=='function'||typeof r?.generate!=='function') process.exit(2); process.stdout.write('ok')",
      isolatedSidecar,
    ], { cwd: isolatedDirectory, encoding: 'utf8' });
    assert.equal(smoke.status, 0, smoke.stderr);
    assert.equal(smoke.stdout, 'ok');
    assert.equal(smoke.stderr, '', 'sidecar import must not write SDK/runtime diagnostics to host stderr');
  } finally {
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
  const mainBundle = await readFile(new URL('../target/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(mainBundle, /COPILOT_SDK_AUTH_TOKEN|CLI subprocess/);
});

test('SDK stderr forwarding cannot leak a fake CLI sentinel to host stderr', () => {
  const sentinel = 'PRISM_COPILOT_FAKE_CLI_STDERR_SENTINEL';
  const script = `
    const { spawnSync } = require('node:child_process');
    const { createCopilotSdkRuntime } = require(process.argv[1]);
    const cliPath = process.env.SystemRoot + '\\\\System32\\\\cmd.exe';
    const args = ['/d', '/s', '/c', 'echo ${sentinel} 1>&2'];
    const probe = spawnSync(cliPath, [...args, '--probe'], { encoding: 'utf8' });
    if (probe.status !== 0 || !probe.stderr.includes('${sentinel}')) process.exit(31);
    const runtime = createCopilotSdkRuntime({
      stdioConnection: () => ({ kind: 'stdio', path: cliPath, args }),
    });
    const expectedAccount = { host: 'github.com', login: 'copilot-user' };
    runtime.listModels({ cliPath, expectedAccount }).then(
      () => process.exit(32),
      () => process.stdout.write('fake-cli-failure-contained'),
    );
  `;
  const result = spawnSync(process.execPath, ['-e', script, runtimeBundlePath], {
    cwd: testDirectory,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fake-cli-failure-contained');
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
});
