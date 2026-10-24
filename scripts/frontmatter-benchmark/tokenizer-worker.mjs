// Dedicated worker holding the pinned model tokenizer. It returns real token IDs (special tokens included)
// so inputs can be counted and projected before they reach the embedding worker. It never fetches.
import { AutoTokenizer, env } from '@huggingface/transformers';
import { LOCAL_MODEL } from '../../src/core/provider/local-embedding-model.ts';
import installNodeNetworkGuard from './node-network-guard.cjs';

const disabledFetch = async () => { throw new Error('Network disabled for the benchmark tokenizer.'); };
globalThis.fetch = disabledFetch;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFS = false;
env.useFSCache = false;
env.useBrowserCache = false;
env.useCustomCache = true;
let tokenizer;

// Electron may expose Node in workers; when it does, Node networking is guarded here like in the renderer.
const nodeRequire = Reflect.get(globalThis, 'require');
const nodeNetwork = [];
const nodeGuard = typeof nodeRequire === 'function'
  ? installNodeNetworkGuard(nodeRequire, 'worker', (entry) => nodeNetwork.push(entry)) : false;

globalThis.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const files = data.files;
      env.customCache = {
        match: async (key) => {
          const name = Object.keys(files).find((file) => key.endsWith(`/${file}`));
          return name ? new Response(files[name]) : undefined;
        },
        put: async () => { throw new Error('Tokenizer cache is read-only.'); },
      };
      tokenizer = await AutoTokenizer.from_pretrained(LOCAL_MODEL.id, { revision: LOCAL_MODEL.revision, local_files_only: true });
      globalThis.postMessage({ id: data.id, modelMaxLength: tokenizer.model_max_length });
    } else if (data.type === 'tokenize') {
      if (!tokenizer) throw new Error('Tokenizer is not ready.');
      globalThis.postMessage({ id: data.id, ids: data.texts.map((text) => Array.from(tokenizer.encode(text), Number)) });
    } else if (data.type === 'status') {
      globalThis.postMessage({ id: data.id, online: navigator.onLine, nodeAvailable: typeof nodeRequire === 'function',
        nodeGuard, fetchDisabled: globalThis.fetch === disabledFetch, nodeNetwork });
    } else if (data.type === 'probe') {
      // Probes the worker's own network paths with a synthetic, non-resolvable URL; both must refuse.
      let fetchRefused = false;
      try { await disabledFetch(data.url); } catch { fetchRefused = true; }
      let nodeRefused = null;
      if (nodeGuard) {
        try { nodeRequire('node:net').connect(443, new URL(data.url).hostname).destroy(); nodeRefused = false; }
        catch { nodeRefused = true; }
      }
      globalThis.postMessage({ id: data.id, fetchRefused, nodeRefused });
    }
  } catch (error) {
    globalThis.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
