// Parity preflight only (never used for measured inference): builds the feature-extraction pipeline with the same
// options as src/obsidian/local-embedding-worker.ts and exposes the token IDs that pipeline produces, so the separate
// tokenizer Worker can be compared with the actual pipeline tokenizer. Its vectors are compared with the product
// Worker's to show both pipelines are the same.
import { env, pipeline } from '@huggingface/transformers';
import { LOCAL_MODEL } from '../../src/core/provider/local-embedding-model.ts';

globalThis.fetch = async () => { throw new Error('Network disabled for the parity worker.'); };
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFS = false;
env.useFSCache = false;
env.useBrowserCache = false;
env.useCustomCache = true;
const wasm = env.backends.onnx.wasm;
wasm.numThreads = 1;
wasm.proxy = false;
let extractor;

globalThis.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const files = data.models;
      env.customCache = {
        match: async (key) => {
          const name = Object.keys(files).find((file) => key.endsWith(`/${file}`));
          return name ? new Response(files[name]) : undefined;
        },
        put: async () => { throw new Error('Parity cache is read-only.'); },
      };
      const factory = URL.createObjectURL(new Blob([data.factory], { type: 'text/javascript' }));
      const wrapper = URL.createObjectURL(new Blob([
        `import factory from ${JSON.stringify(factory)}; export default (options) => factory({ ...options, locateFile: () => 'prism-local-wasm' });`,
      ], { type: 'text/javascript' }));
      wasm.wasmPaths = { mjs: wrapper };
      wasm.wasmBinary = new Uint8Array(data.wasm);
      extractor = await pipeline('feature-extraction', LOCAL_MODEL.id, {
        revision: LOCAL_MODEL.revision, dtype: 'q8', device: 'wasm', local_files_only: true,
      });
      globalThis.postMessage({ id: data.id, modelMaxLength: extractor.tokenizer.model_max_length });
    } else if (data.type === 'tokenize') {
      // FeatureExtractionPipeline tokenizes with exactly these options before inference.
      const ids = data.texts.map((text) => Array.from(extractor.tokenizer(text, { padding: true, truncation: true }).input_ids.data, Number));
      globalThis.postMessage({ id: data.id, ids });
    } else if (data.type === 'embed') {
      const vectors = [];
      for (const text of data.texts) vectors.push(Array.from((await extractor(text, { pooling: 'mean', normalize: true })).data, Number));
      globalThis.postMessage({ id: data.id, vectors });
    }
  } catch (error) {
    globalThis.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
