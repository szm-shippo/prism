import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { LOCAL_MODEL } from '../core/provider/local-embedding-model';

const port = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(message: unknown): void;
};
let extractor: FeatureExtractionPipeline | undefined;
let pending = Promise.resolve();

// The dedicated worker has no network access, including optional runtime/model fetches.
globalThis.fetch = async () => { throw new Error('Network disabled for local embeddings.'); };
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFS = false;
env.useFSCache = false;
env.useBrowserCache = false;
env.useCustomCache = true;
const wasm = env.backends.onnx.wasm;
if (!wasm) throw new Error('WASM backend unavailable.');
wasm.numThreads = 1;
wasm.proxy = false;
const createExtractor = pipeline as unknown as (task: 'feature-extraction', model: string,
  options: { revision: string; dtype: 'q8'; device: 'wasm'; local_files_only: true }) => Promise<FeatureExtractionPipeline>;

port.onmessage = (event) => {
  const message = event.data;
  pending = pending.then(async () => {
    try {
      if (message.type === 'init') {
        const files = message.models as Record<string, ArrayBuffer>;
        env.customCache = {
          match: async (key: string) => {
            const name = Object.keys(files).find((file) => key.endsWith(`/${file}`));
            return name ? new Response(files[name]) : undefined;
          },
          put: async () => { throw new Error('Local model cache is read-only.'); },
        };
        const factory = URL.createObjectURL(new Blob([message.factory], { type: 'text/javascript' }));
        // Emscripten resolves a relative WASM URL even when wasmBinary is supplied.
        // A Blob module has no hierarchical base URL, so provide locateFile explicitly.
        const wrapper = URL.createObjectURL(new Blob([
          `import factory from ${JSON.stringify(factory)}; export default (options) => factory({ ...options, locateFile: () => 'prism-local-wasm' });`,
        ], { type: 'text/javascript' }));
        wasm.wasmPaths = { mjs: wrapper };
        wasm.wasmBinary = new Uint8Array(message.wasm);
        try {
          extractor = await createExtractor('feature-extraction', LOCAL_MODEL.id, {
            revision: LOCAL_MODEL.revision, dtype: 'q8', device: 'wasm', local_files_only: true,
          });
          for (const name of Object.keys(files)) delete files[name];
        } finally { URL.revokeObjectURL(wrapper); URL.revokeObjectURL(factory); }
        port.postMessage({ id: message.id, vectors: [] });
      } else if (message.type === 'embed') {
        if (!extractor) throw new Error('Model is not ready.');
        const vectors: number[][] = [];
        // One input at a time bounds activation memory on mobile devices.
        for (const text of message.texts as string[]) {
          const output = await extractor(text, { pooling: 'mean', normalize: true });
          const vector = Array.from(output.data, Number);
          if (vector.length !== LOCAL_MODEL.dimensions || vector.some((value) => !Number.isFinite(value)) ||
              !vector.some((value) => value !== 0)) {
            throw new Error('Invalid local vector.');
          }
          vectors.push(vector);
        }
        port.postMessage({ id: message.id, vectors });
      }
    } catch { port.postMessage({ id: message.id, error: true }); }
  });
};
