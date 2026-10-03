import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

async function bundle(file, plugins = []) {
  return (await build({ entryPoints: [fileURLToPath(new URL(`../src/obsidian/${file}.ts`, import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'], plugins,
  })).outputFiles[0].text;
}

const fixtures = { 'config.json': new TextEncoder().encode('{}').buffer,
  'onnx/model_quantized.onnx': new Uint8Array([1, 2, 3]).buffer };
const manifest = await Promise.all(Object.entries(fixtures).map(async ([name, bytes]) => ({ name, size: bytes.byteLength,
  hash: Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join(''),
})));
const managerBundle = await bundle('local-embedding-model', [{ name: 'tiny-test-model', setup(builder) {
  builder.onLoad({ filter: /core[\\/]provider[\\/]local-embedding-model\.ts$/ }, () => ({
    contents: `export const LOCAL_MODEL = { id: 'fixture/model', revision: 'pinned' };
      export const LOCAL_MODEL_KEY = 'fixture-pinned'; export const MODEL_FILES = ${JSON.stringify(manifest)};`,
    loader: 'js',
  }));
} }]);

function manager(download) {
  const data = new Map();
  const module = { exports: {} };
  runInNewContext(managerBundle, { module, exports: module.exports, crypto: webcrypto, TextDecoder,
    require: () => ({ requestUrl() { throw new Error('Unexpected request'); } }),
  });
  const adapter = {
    async exists(path) { return data.has(path); }, async mkdir(path) { data.set(path, null); },
    async read(path) { if (!data.has(path)) throw new Error('missing'); return data.get(path); },
    async readBinary(path) { if (!data.has(path)) throw new Error('missing'); return data.get(path).slice(0); },
    async write(path, value) { data.set(path, value); }, async writeBinary(path, value) { data.set(path, value.slice(0)); },
  };
  return { model: new module.exports.LocalEmbeddingModel(adapter, '.obsidian/plugins/prism', download), data,
    Model: module.exports.LocalEmbeddingModel, adapter };
}

test('missing model never downloads on load; user-started download pins URLs, validates files, and repairs corrupt cache', async () => {
  const calls = [];
  const { model, data } = manager(async (url) => {
    calls.push(url);
    return fixtures[url.split('/pinned/')[1]].slice(0);
  });
  assert.equal(await model.isReady(), false);
  await assert.rejects(model.load(), /Download.*settings/);
  assert.equal(calls.length, 0);
  await model.install();
  assert.equal(await model.isReady(), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith('https://huggingface.co/fixture/model/resolve/pinned/')));
  assert.equal(Object.keys(await model.load()).length, 2);
  data.set(`${model.directory}/onnx/model_quantized.onnx`, new Uint8Array([9, 9, 9]).buffer);
  await assert.rejects(model.load(), /damaged/);
  await model.install();
  assert.equal(calls.length, 3);
  assert.equal(Object.keys(await model.load()).length, 2);
});

test('cancelled or failed model download cannot publish readiness and retry reuses verified files', async () => {
  let count = 0;
  let cancel = true;
  const { model } = manager(async (url) => {
    count++;
    if (url.endsWith('.onnx') && cancel) model.cancel();
    return fixtures[url.split('/pinned/')[1]].slice(0);
  });
  await assert.rejects(model.install(), /cancelled/);
  assert.equal(await model.isReady(), false);
  assert.equal(model.busy, false);
  cancel = false;
  await model.install();
  assert.equal(count, 3);
  assert.equal(await model.isReady(), true);
  const failed = manager(async () => { throw new Error('network payload must not appear'); }).model;
  await assert.rejects(failed.install(), (error) => {
    assert.match(error.message, /internet access and free storage/);
    assert.doesNotMatch(error.message, /payload/);
    return true;
  });
  assert.equal(await failed.isReady(), false);
});

test('model storage rejects absolute or traversing plugin directories before any IO', () => {
  const { Model, adapter } = manager();
  for (const path of ['/tmp/model', '../model', '.obsidian/../model', 'C:/model', 'folder\\model']) {
    assert.throws(() => new Model(adapter, path), /inside the plugin directory/);
  }
});

const providerBundle = await bundle('local-embedding-provider');
test('local provider shares worker startup, bounds requests, and retries after a worker crash without networking', async () => {
  const workers = [];
  let loads = 0;
  class FakeWorker {
    constructor() { workers.push(this); }
    postMessage(message) {
      queueMicrotask(() => this.onmessage({ data: { id: message.id,
        vectors: message.type === 'init' ? [] : message.texts.map(() => [1, 0]) } }));
    }
    terminate() { this.stopped = true; }
  }
  const module = { exports: {} };
  runInNewContext(providerBundle, { module, exports: module.exports, Worker: FakeWorker, performance, Blob, URL, setTimeout, clearTimeout,
    fetch() { assert.fail('no local inference network access'); },
  });
  const provider = new module.exports.LocalEmbeddingProvider({
    async load() { loads++; return { model: new ArrayBuffer(1) }; },
    async loadRuntime() { return { script: '', factory: '', wasm: new ArrayBuffer(1) }; },
  });
  assert.equal((await provider.embedBatch([])).length, 0);
  const vectors = await Promise.all([provider.embed('private text'), provider.embed('private query')]);
  assert.deepEqual(structuredClone(vectors), [[1, 0], [1, 0]]);
  assert.equal(loads, 1);
  workers[0].onerror();
  assert.equal(workers[0].stopped, true);
  await provider.embed('retry');
  assert.equal(loads, 2);
  provider.dispose();
});

const workerBundle = await bundle('local-embedding-worker', [{ name: 'fake-engine', setup(builder) {
  builder.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: 'engine', external: true }));
} }]);
test('worker disables every network fetch and uses only cached model files and transferred WASM bytes', async () => {
  const env = { backends: { onnx: { wasm: {} } } };
  const results = [];
  let options;
  const context = { module: { exports: {} }, Blob, URL, Response, Uint8Array,
    postMessage(message) { results.push(message); },
    require: () => ({ env, pipeline: async (_task, _model, requested) => {
      options = requested;
      assert.equal(env.allowRemoteModels, false);
      assert.equal(env.useBrowserCache, false);
      assert.equal(env.useFS, false);
      assert.equal(env.backends.onnx.wasm.numThreads, 1);
      assert.equal(env.backends.onnx.wasm.wasmBinary.byteLength, 2);
      assert.equal(await env.customCache.match('unexpected/file'), undefined);
      assert.equal(await (await env.customCache.match('/models/model/config.json')).text(), '{}');
      return async () => ({ data: Array(384).fill(0.01) });
    } }),
  };
  runInNewContext(workerBundle, context);
  await assert.rejects(context.fetch('https://example.com', { body: 'private text' }), /Network disabled/);
  context.onmessage({ data: { id: 1, type: 'init', factory: '', wasm: new ArrayBuffer(2), models: fixtures } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(options.local_files_only, true);
  assert.equal(options.device, 'wasm');
  context.onmessage({ data: { id: 2, type: 'embed', texts: ['private query'] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(results[1].vectors[0].length, 384);
});
