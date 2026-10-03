import esbuild from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

const production = process.argv[2] === 'production';
const workerContext = await esbuild.context({
  entryPoints: ['src/obsidian/local-embedding-worker.ts'], bundle: true,
  platform: 'browser', format: 'esm', target: 'es2021',
  outfile: 'local-embedding-worker.js', minify: production,
});
await workerContext.rebuild();
if (production) await workerContext.dispose();
else await workerContext.watch();
await mkdir('target', { recursive: true });
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  await copyFile(`node_modules/onnxruntime-web/dist/${name}`, name);
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
    await copyFile('manifest.json', 'target/manifest.json');
  } finally {
    await context.dispose();
  }
} else {
  await context.watch();
}
