import esbuild from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { suppressCopilotCliStderrPlugin } from './scripts/copilot-sdk-stderr-plugin.mjs';

const production = process.argv[2] === 'production';
const workerContext = await esbuild.context({
  entryPoints: ['src/obsidian/local-embedding-worker.ts'], bundle: true,
  platform: 'browser', format: 'esm', target: 'es2021',
  // Obsidian Desktop exposes Node in workers; inference must use the web backend.
  define: { process: 'undefined', 'globalThis.process': 'undefined' },
  outfile: 'local-embedding-worker.js', minify: production,
});
await workerContext.rebuild();
if (production) await workerContext.dispose();
else await workerContext.watch();
await mkdir('target', { recursive: true });
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  if (name.endsWith('.mjs')) {
    const factory = await readFile(`node_modules/onnxruntime-web/dist/${name}`, 'utf8');
    const { code } = await esbuild.transform(factory, {
      format: 'esm', target: 'es2022', define: { process: 'undefined', 'globalThis.process': 'undefined' },
    });
    await writeFile(name, code);
  } else {
    await copyFile(`node_modules/onnxruntime-web/dist/${name}`, name);
  }
  await copyFile(name, `target/${name}`);
}
await copyFile('local-embedding-worker.js', 'target/local-embedding-worker.js');
const licenses = await Promise.all([
  'node_modules/@huggingface/transformers/LICENSE',
  'node_modules/@huggingface/jinja/LICENSE',
  'docs/licenses/onnxruntime.txt',
  'docs/licenses/onnxruntime-third-party.txt',
].map((path) => readFile(path, 'utf8')));
await writeFile('target/LOCAL_EMBEDDING_LICENSES.txt', licenses.join('\n\n'));

const copilotRuntimeContext = await esbuild.context({
  entryPoints: ['src/obsidian/copilot-sdk-runtime.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['koffi'],
  outfile: 'copilot-sdk-runtime.cjs',
  minify: production,
  logLevel: 'info',
  plugins: [suppressCopilotCliStderrPlugin()],
});
await copilotRuntimeContext.rebuild();
if (production) await copilotRuntimeContext.dispose();
else await copilotRuntimeContext.watch();

const copilotLicenses = [
  ['GitHub Copilot SDK', 'docs/licenses/copilot-sdk-mit.txt'],
  ['vscode-jsonrpc', 'node_modules/vscode-jsonrpc/License.txt'],
  ['zod', 'node_modules/zod/LICENSE'],
  ['koffi (optional SDK dependency)', 'node_modules/koffi/LICENSE.txt'],
];
const copilotLicenseText = await Promise.all(copilotLicenses.map(async ([name, path]) =>
  `${name}\n${await readFile(path, 'utf8')}`));
await writeFile('target/COPILOT_SDK_LICENSES.txt', copilotLicenseText.join('\n\n'));

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2021',
  outfile: 'main.js',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
});

if (production) {
  try {
    await context.rebuild();
    await copyFile('main.js', 'target/main.js');
    await copyFile('copilot-sdk-runtime.cjs', 'target/copilot-sdk-runtime.cjs');
    await copyFile('manifest.json', 'target/manifest.json');
  } finally {
    await context.dispose();
  }
} else {
  await context.watch();
}
