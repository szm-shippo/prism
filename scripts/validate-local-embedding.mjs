// Opt-in integration check. Only public model files are downloaded; inputs are synthetic.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, _electron } from 'playwright';

const definitions = await build({ entryPoints: ['src/core/provider/local-embedding-model.ts'],
  bundle: true, format: 'esm', write: false });
const { LOCAL_MODEL, MODEL_FILES } = await import(`data:text/javascript;base64,${Buffer.from(definitions.outputFiles[0].text).toString('base64')}`);
const directory = `target/models/${LOCAL_MODEL.revision}`;
await mkdir(`${directory}/onnx`, { recursive: true });
for (const file of MODEL_FILES) {
  const path = `${directory}/${file.name}`;
  const valid = (bytes) => bytes.length === file.size &&
    (!file.hash || createHash('sha256').update(bytes).digest('hex') === file.hash);
  let bytes;
  try { bytes = await readFile(path); } catch {}
  if (!bytes || !valid(bytes)) {
    if (!process.argv.includes('--download-model')) throw new Error('Missing fixture model. Use --download-model to download public Hugging Face files.');
    console.log(`Downloading ${file.name}`);
    const response = await fetch(`https://huggingface.co/${LOCAL_MODEL.id}/resolve/${LOCAL_MODEL.revision}/${file.name}`);
    if (!response.ok) throw new Error(`Model download: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!valid(bytes)) throw new Error('Model integrity check failed.');
    await writeFile(path, bytes);
  }
}
await build({ entryPoints: ['src/obsidian/local-embedding-provider.ts'], bundle: true,
  platform: 'browser', format: 'esm', outfile: 'target/local-provider-test.js' });

const server = createServer(async (request, response) => {
  const name = decodeURIComponent(request.url.slice(1));
  if (!name) { response.end('<!doctype html><title>Prism local model validation</title>'); return; }
  if (name.includes('..') || name.includes('\\')) { response.writeHead(400).end(); return; }
  try {
    response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    response.end(await readFile(`target/${name}`));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
let electron;
try {
  const electronMode = process.argv.includes('--electron');
  if (electronMode) {
    const fixtureEnv = { ...process.env, PRISM_TEST_PORT: String(server.address().port) };
    delete fixtureEnv.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ args: ['scripts/local-embedding-electron-fixture.cjs'],
      env: fixtureEnv });
  } else {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PRISM_BROWSER || undefined });
  }
  const context = electron ? electron.context() : await browser.newContext();
  const page = electron ? await electron.firstWindow() : await context.newPage();
  page.on('console', (event) => { if (event.type() === 'error') console.error(event.text()); });
  page.on('pageerror', (error) => console.error(error.message));
  const external = [];
  await context.route('**/*', (route) => {
    if (!route.request().url().startsWith('http://127.0.0.1:') &&
        !route.request().url().startsWith('app://obsidian.md/')) {
      external.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  if (!electron) await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async ({ directory, names }) => {
    const { LocalEmbeddingProvider } = await import('/local-provider-test.js');
    const models = {};
    for (const name of names) models[name] = await (await fetch(`/${directory}/${name}`)).arrayBuffer();
    const script = await (await fetch('/local-embedding-worker.js')).text();
    const factory = await (await fetch('/ort-wasm-simd-threaded.jsep.mjs')).text();
    const wasm = await (await fetch('/ort-wasm-simd-threaded.jsep.wasm')).arrayBuffer();
    window.provider = new LocalEmbeddingProvider({
      load: async () => models, loadRuntime: async () => ({ script, factory, wasm }),
    });
  }, { directory: `models/${LOCAL_MODEL.revision}`, names: MODEL_FILES.map((file) => file.name) });
  await context.setOffline(true);
  const result = await page.evaluate(async () => {
    const texts = ['猫がソファで眠っています。', '明日の天気は雨です。', 'データベースのバックアップを保存します。'];
    const start = performance.now();
    const vectors = await window.provider.embedBatch(texts);
    const indexingMs = performance.now() - start;
    const query = await window.provider.embed('子猫は長椅子で休んでいます。');
    const scores = vectors.map((vector) => vector.reduce((sum, value, index) => sum + value * query[index], 0));
    const best = scores.indexOf(Math.max(...scores));
    if (best !== 0 || vectors.some((vector) => vector.length !== 384)) throw new Error('Paraphrase retrieval failed.');
    return { metrics: window.provider.metrics, indexingMs, scores, best, offline: navigator.onLine === false };
  });
  if (external.length) throw new Error(`Unexpected external requests: ${external.length}`);
  let privateBytes;
  if (process.platform === 'win32' && browser) {
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map((process) => Number(process.id)).filter(Number.isSafeInteger);
    privateBytes = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object -Property PrivateMemorySize64 -Sum).Sum`],
    { encoding: 'utf8' }).trim());
  }
  const version = electron
    ? await electron.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome }))
    : browser.version();
  console.log(JSON.stringify({ ...result, browserPrivateBytesAfterInference: privateBytes,
    externalRequests: external.length, browser: version }, null, 2));
  await page.evaluate(() => window.provider.dispose());
} finally {
  await browser?.close();
  await electron?.close();
  await new Promise((resolve) => server.close(resolve));
}
