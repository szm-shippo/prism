// Drives real-model runs in the isolated Electron host. Each (run, config) gets a fresh process and profile with
// its own vault copy and on-disk store. Assets are staged first, then the browser is switched offline before any
// inference; network monitors and synthetic probes are recorded separately from actual run traffic.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { sha256 } from './dataset.mjs';
import { STAGES, recomputeQuestion, summarizeRun } from './metrics.mjs';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const harnessRoot = path.join(projectRoot, 'scripts', 'frontmatter-benchmark');
export const SCENARIOS = ['nonTargetFrontmatter', 'indexedAttribute', 'body'];
export const PROBE_HOST = 'prism-offline-probe.invalid';
const SAMPLE_INTERVAL_MS = 100;
const QUIESCENCE = { intervalMs: 250, maxSamples: 40, window: 3, tolerance: 0.01 };
const PARITY_PROBES = ['Plain ASCII sentence for parity.', '日本語の文章とカタカナ、ひらがな。', '絵文字 👩‍💻🎉 and mixed text',
  'Combining é and café', 'Line one\r\nLine two\rLine three', 'ＡＢＣ①㍿ full-width', ' ', '#tag [[link]] `code`',
  `${'token '.repeat(700)}tail`, `${'あいうえお'.repeat(300)}`];

async function listFiles(directory, filter) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, filter));
    else if (filter(absolute)) files.push(absolute);
  }
  return files;
}

/** SHA-256 over the harness, product sources and lockfile, so results and anchors can be tied to one freeze. */
export async function implementationHash() {
  const files = [
    path.join(projectRoot, 'scripts', 'benchmark-frontmatter-search.mjs'),
    path.join(projectRoot, 'package-lock.json'),
    ...(await readdir(harnessRoot, { withFileTypes: true })).filter((entry) => entry.isFile())
      .map((entry) => path.join(harnessRoot, entry.name)),
    ...await listFiles(path.join(projectRoot, 'src'), (file) => file.endsWith('.ts')),
  ].sort();
  const entries = {};
  for (const file of files) entries[path.relative(projectRoot, file).split(path.sep).join('/')] = sha256(await readFile(file));
  return { sha256: sha256(JSON.stringify(entries)), files: entries };
}

function git(args) {
  try { return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

/** Bundles a TypeScript or ESM module for Node and imports it (used for the main chunker and model definitions). */
export async function importForNode(relativePath) {
  const { outputFiles } = await build({ entryPoints: [path.join(projectRoot, relativePath)], bundle: true, platform: 'node',
    format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
}

async function bundle(entry, outfile, format) {
  await build({ entryPoints: [entry], bundle: true, platform: 'browser', format, target: 'es2022', outfile,
    // Electron exposes Node in this renderer and its workers; Transformers.js must use its web code paths.
    define: { process: 'undefined', 'globalThis.process': 'undefined' }, logLevel: 'silent' });
  return sha256(await readFile(outfile));
}

/** Verifies the pinned local model and the npm-built runtime; never downloads. */
async function runtimeAssets(bundleDirectory) {
  const { LOCAL_MODEL, MODEL_FILES } = await importForNode('src/core/provider/local-embedding-model.ts');
  const served = {};
  const hashes = {};
  for (const file of MODEL_FILES) {
    const absolute = path.join(projectRoot, 'target', 'models', LOCAL_MODEL.revision, ...file.name.split('/'));
    let bytes;
    try { bytes = await readFile(absolute); } catch { bytes = undefined; }
    if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.hash) {
      throw new Error(`Pinned model file ${file.name} is missing or invalid; this gate is BLOCKED (no download is attempted).`);
    }
    served[`models/${LOCAL_MODEL.revision}/${file.name}`] = absolute;
    hashes[`model:${file.name}`] = file.hash;
  }
  for (const name of ['local-embedding-worker.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    const absolute = path.join(projectRoot, 'target', name);
    try { hashes[name] = sha256(await readFile(absolute)); }
    catch { throw new Error(`Runtime ${name} is missing; run npm run build first.`); }
    served[name] = absolute;
  }
  await mkdir(bundleDirectory, { recursive: true });
  for (const name of ['engine', 'tokenizer-worker', 'parity-worker', 'worker-guard']) {
    const outfile = path.join(bundleDirectory, `${name}.js`);
    hashes[`frontmatter-benchmark/${name}.js`] = await bundle(path.join(harnessRoot, `${name}.mjs`), outfile, name === 'worker-guard' ? 'iife' : 'esm');
    served[`frontmatter-benchmark/${name}.js`] = outfile;
  }
  const tokenizer = MODEL_FILES.find((file) => file.name === 'tokenizer.json');
  const transformers = JSON.parse(await readFile(path.join(projectRoot, 'node_modules/@huggingface/transformers/package.json'), 'utf8'));
  return { model: { ...LOCAL_MODEL, dtype: 'q8', device: 'wasm', threads: 1, pooling: 'mean', normalize: true },
    transformersVersion: transformers.version, modelFiles: MODEL_FILES.map((file) => file.name), tokenizerSha256: tokenizer.hash,
    served, hashes };
}

async function processMemory(electron) {
  const metrics = await electron.evaluate(({ app }) => app.getAppMetrics());
  const sum = (key) => metrics.every((item) => typeof item.memory?.[key] === 'number')
    ? metrics.reduce((total, item) => total + item.memory[key] * 1024, 0) : null;
  return { privateBytes: sum('privateBytes'), workingSetBytes: sum('workingSetSize'), peakWorkingSetBytes: sum('peakWorkingSetSize'),
    pids: metrics.map((item) => item.pid).sort((a, b) => a - b), processTypes: metrics.map((item) => item.type).sort() };
}

/** Polls summed process memory while a phase runs and keeps the largest observed values. */
function startSampler(electron) {
  const peaks = { privateBytes: 0, workingSetBytes: 0, peakWorkingSetBytes: 0, samples: 0, errors: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const sample = await processMemory(electron);
        for (const key of ['privateBytes', 'workingSetBytes', 'peakWorkingSetBytes']) peaks[key] = Math.max(peaks[key], sample[key] ?? 0);
        peaks.samples += 1;
      } catch {
        peaks.errors += 1;
      }
      await delay(SAMPLE_INTERVAL_MS);
    }
  })();
  return async () => { running = false; await loop; return peaks; };
}

/**
 * Post-GC quiescent memory: samples until the last three share one PID set and their summed private bytes lie
 * within 1%, or reports `stable: false` after 40 samples (10 s). An unstable sample cannot pass a memory gate.
 */
async function quiescentMemory(electron, call) {
  const gc = await call('collectGarbage');
  const samples = [];
  for (let index = 0; index < QUIESCENCE.maxSamples; index += 1) {
    samples.push(await processMemory(electron));
    const recent = samples.slice(-QUIESCENCE.window);
    if (recent.length === QUIESCENCE.window && recent.every((sample) => typeof sample.privateBytes === 'number' &&
        JSON.stringify(sample.pids) === JSON.stringify(recent[0].pids))) {
      const values = recent.map((sample) => sample.privateBytes);
      if (Math.max(...values) - Math.min(...values) <= QUIESCENCE.tolerance * Math.max(...values)) {
        return { gc, stable: true, ...samples.at(-1), samples: samples.map((sample) => sample.privateBytes) };
      }
    }
    await delay(QUIESCENCE.intervalMs);
  }
  return { gc, stable: false, ...samples.at(-1), samples: samples.map((sample) => sample.privateBytes) };
}

async function stageProfile(profile, inputs, prepareProfile) {
  const directories = Object.fromEntries(['user', 'vault', 'store', 'baseline', 'tmp'].map((name) => [name, path.join(profile, name)]));
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
  directories.workerGuardLog = path.join(directories.tmp, 'embedding-worker-network.jsonl');
  for (const note of inputs.notes) {
    const target = path.join(directories.vault, ...note.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, note.content, { flag: 'wx' });
  }
  // The frozen SourceRegistry snapshot is the only state present before the timed rebuild.
  await writeFile(path.join(directories.store, 'sources.json'), JSON.stringify(inputs.sourceRecords), { flag: 'wx' });
  await prepareProfile?.(directories);
  return directories;
}

async function launch(playwright, electronPath, assets, directories) {
  const env = { PRISM_FMB_PROFILE: directories.user, PRISM_FMB_FILES: JSON.stringify(assets.served),
    TEMP: directories.tmp, TMP: directories.tmp, TMPDIR: directories.tmp };
  for (const name of ['SystemRoot', 'windir', 'PATH']) if (process.env[name]) env[name] = process.env[name];
  const electron = await playwright._electron.launch({ executablePath: electronPath, args: [path.join(harnessRoot, 'electron-main.cjs')], env });
  const page = await electron.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForURL('app://obsidian.md/');
  await page.evaluate(() => import('/frontmatter-benchmark/engine.js'));
  const call = (method, ...args) => page.evaluate(([name, values]) => globalThis.prismFrontmatterBenchmark[name](...values), [method, args]);
  return { electron, call, pageErrors };
}

/** Switches the browser context offline and probes every network path; nothing may escape. */
async function goOffline(electron, call) {
  await electron.context().setOffline(true);
  const status = await call('networkStatus');
  const probe = await call('probe', `https://${PROBE_HOST}/prism-synthetic-probe`);
  probe.mainNode = await electron.evaluate((_electron, host) => globalThis.prismProbeMainNetwork(host), PROBE_HOST);
  return { before: { pageOnline: status.pageOnline, workerOnline: status.worker.online }, probe };
}

async function embeddingWorkerLog(file) {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function networkEvidence(electron, call, offline, directories) {
  const status = await call('networkStatus');
  const chromium = await electron.evaluate(() => globalThis.prismNetwork);
  const monitors = await electron.evaluate(() => globalThis.prismMonitors);
  const workerLog = await embeddingWorkerLog(directories.workerGuardLog);
  const node = [...await electron.evaluate(() => globalThis.prismNodeNetwork), ...status.rendererNodeNetwork, ...status.worker.nodeNetwork,
    ...workerLog.filter((entry) => entry.api !== 'guard-installed')];
  const isProbe = (text) => String(text).includes(PROBE_HOST);
  return {
    offline: { before: offline.before, after: { pageOnline: status.pageOnline, workerOnline: status.worker.online } },
    monitors: { chromiumWebRequest: monitors.chromiumWebRequest, mainNodeGuard: monitors.mainNodeGuard,
      rendererNodeGuard: status.rendererNodeGuard, workerNodeAvailable: status.worker.nodeAvailable,
      workerNodeGuard: status.worker.nodeGuard, workerFetchDisabled: status.worker.fetchDisabled,
      embeddingWorkerNodeGuard: workerLog.some((entry) => entry.api === 'guard-installed') },
    probes: { ...offline.probe, observed: { chromium: chromium.filter((entry) => isProbe(entry.url)).length,
      node: node.filter((entry) => isProbe(entry.target)).length } },
    actual: { chromiumBlocked: chromium.filter((entry) => !entry.allowed && !isProbe(entry.url)).length,
      nodeExternal: node.filter((entry) => !entry.allowed && !isProbe(entry.target)).length },
    chromiumRequests: chromium.filter((entry) => !isProbe(entry.url)),
    nodeRequests: node.filter((entry) => !isProbe(entry.target)),
  };
}

async function measure({ playwright, electronPath, assets, inputs, config, run, prepareProfile }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'prism-fmb-'));
  try {
    const directories = await stageProfile(profile, inputs, prepareProfile);
    const { electron, call, pageErrors } = await launch(playwright, electronPath, assets, directories);
    let sampling;
    // A failed phase must not leave a sampler polling a closed app.
    const startPhase = () => { sampling = startSampler(electron); return sampling; };
    try {
      const memory = { beforeStage: await processMemory(electron) };
      const setup = await call('stage', { config, notes: inputs.notes.map((note) => ({ path: note.path, normalizedSha256: sha256(note.content) })),
        directories, modelFiles: assets.modelFiles, tokenizerSha256: assets.tokenizerSha256, chunksSha256: inputs.binding.chunksSha256 });
      const offline = await goOffline(electron, call);
      setup.warmup = await call('warmup');
      memory.postInit = await quiescentMemory(electron, call);
      let stop = startPhase();
      const buildResult = await call('build');
      const buildPeaks = await stop();
      memory.postIndex = await quiescentMemory(electron, call);
      stop = startPhase();
      const queries = await call('runQueries', inputs.questions);
      const queryPeaks = await stop();
      memory.postQueries = await quiescentMemory(electron, call);
      const updates = {};
      for (const scenario of SCENARIOS) {
        stop = startPhase();
        updates[scenario] = await call('runUpdate', scenario, inputs.updates.notes, inputs.updates.edits[scenario]);
        updates[scenario].peaks = await stop();
        updates[scenario].memory = await quiescentMemory(electron, call);
      }
      memory.peaks = Object.fromEntries(['privateBytes', 'workingSetBytes', 'peakWorkingSetBytes'].map((key) =>
        [key, Math.max(buildPeaks[key], queryPeaks[key], ...SCENARIOS.map((scenario) => updates[scenario].peaks[key]))]));
      memory.peaks.label = 'sampled every 100 ms during build, queries and updates; peakWorkingSetBytes is the OS working-set peak, not private bytes';
      const network = await networkEvidence(electron, call, offline, directories);
      await call('dispose');
      const versions = await electron.evaluate(() => ({ ...process.versions }));
      for (const question of queries.questions) question.metrics = recomputeQuestion(question);
      return { config, run, binding: inputs.binding, setup, network, build: buildResult, queries,
        summary: summarizeRun(queries.questions), updates, memory, versions, pageErrors };
    } finally {
      await sampling?.();
      await electron.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Runs the tokenizer parity preflight in its own Electron process (no measured inference). */
async function parityPreflight({ playwright, electronPath, assets, inputs }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'prism-fmb-parity-'));
  try {
    const directories = await stageProfile(profile, inputs);
    const { electron, call } = await launch(playwright, electronPath, assets, directories);
    try {
      await call('stage', { config: 'parity', notes: [], directories, modelFiles: assets.modelFiles,
        tokenizerSha256: assets.tokenizerSha256, chunksSha256: inputs.binding.chunksSha256 });
      const offline = await goOffline(electron, call);
      const probes = [...PARITY_PROBES, ...inputs.snapshotChunks.map((chunk) => chunk.content), ...inputs.questions.map((question) => question.question)];
      const report = await call('runParity', { probes, vectorProbes: PARITY_PROBES.slice(0, 4) });
      return { ...report, offline: offline.before, transformersVersion: assets.transformersVersion, tokenizerSha256: assets.tokenizerSha256 };
    } finally {
      await electron.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function csvRows(record) {
  const quote = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  return record.queries.questions.flatMap((question) => STAGES.map((stage) => {
    const metrics = question.metrics[stage];
    return [record.config, record.run, question.id, question.group, question.route, stage, question.gold.sourceId,
      question.gold.chunkId, metrics.goldRank ?? '', metrics.recallAt1, metrics.recallAt3, metrics.recallAt6, metrics.wrongNoteTop1,
      metrics.wrongNoteTop3Slots, metrics.goldSourceInTop6, metrics.firstGoldSourceChunkTop6 ?? '', metrics.sectionFirstAt6,
      question.stages[stage].map((hit) => hit.chunkId).join(' ')].map(quote).join(',');
  }));
}

/**
 * Runs the parity preflight, then `runs` rounds; round r uses the config list rotated by r-1. Writes every raw
 * run file, a CSV and results.json listing each run file's SHA-256.
 */
export async function runLive({ inputs, implementation, configs, runs, out, electronPath, playwrightEntry, anchors }) {
  const startedAt = new Date().toISOString();
  await mkdir(out, { recursive: false });
  const playwright = await import(pathToFileURL(path.resolve(playwrightEntry)).href);
  const assets = await runtimeAssets(path.join(out, 'bundles'));
  const electron = path.resolve(electronPath);
  const parity = await parityPreflight({ playwright, electronPath: electron, assets, inputs });
  await writeFile(path.join(out, 'parity.json'), `${JSON.stringify(parity, null, 2)}\n`, { flag: 'wx' });
  if (!parity.pass) throw new Error('Tokenizer parity preflight failed; the token gate is BLOCKED and no runs were made.');
  await mkdir(path.join(out, 'runs'));
  const references = [];
  const rows = [];
  for (let run = 1; run <= runs; run += 1) {
    const offset = (run - 1) % configs.length;
    for (const config of [...configs.slice(offset), ...configs.slice(0, offset)]) {
      console.log(`Run ${run}: ${config}`);
      const record = await measure({ playwright, electronPath: electron, assets, inputs, config, run });
      const file = `runs/${config}-run${run}.json`;
      const text = `${JSON.stringify(record)}\n`;
      await writeFile(path.join(out, file), text, { flag: 'wx' });
      references.push({ config, run, file, sha256: sha256(text) });
      rows.push(...csvRows(record));
    }
  }
  const header = 'config,run,question,group,route,stage,goldSource,goldChunk,goldRank,r1,r3,r6,wrongNoteTop1,wrongNoteTop3Slots,goldSourceInTop6,firstGoldSourceTop6,sectionFirstAt6,ranked';
  await writeFile(path.join(out, 'results.csv'), `${[header, ...rows].join('\n')}\n`, { flag: 'wx' });
  const results = {
    startedAt,
    finishedAt: new Date().toISOString(),
    binding: inputs.binding,
    implementation: { ...implementation, gitHead: git(['rev-parse', 'HEAD']), gitStatus: git(['status', '--porcelain']) },
    runtime: { model: assets.model, transformersVersion: assets.transformersVersion, assetHashes: assets.hashes, node: process.version,
      os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? null, electron, playwright: path.resolve(playwrightEntry) },
    parity: { pass: parity.pass, sha256: sha256(`${JSON.stringify(parity, null, 2)}\n`) },
    anchors: anchors ? { sha256: anchors.fileSha256 } : null,
    configs,
    runs: references,
  };
  await writeFile(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx' });
  return results;
}

/** True only for the obstructed rename of the body-vector temporary file onto its final path. */
export function isInducedWriteFailure(message) {
  return /\b(EPERM|EISDIR|EEXIST|ENOTEMPTY|EACCES)\b[^\n]*\brename '[^']*vectors-body\.json\.tmp' -> '[^']*vectors-body\.json'/.test(message);
}

/**
 * Non-scored smoke: a directory occupies the body-vector file's path, so the first awaited index write (rename onto
 * it) fails during the timed rebuild; the measurement must fail instead of reporting a rebuild. Config C never
 * reads that file when opening an empty store, so the failure is a write, not a read.
 */
export async function smokeWriteFailure({ inputs, electronPath, playwrightEntry, out }) {
  await mkdir(out, { recursive: false });
  const playwright = await import(pathToFileURL(path.resolve(playwrightEntry)).href);
  const assets = await runtimeAssets(path.join(out, 'bundles'));
  let outcome;
  try {
    await measure({ playwright, electronPath: path.resolve(electronPath), assets, inputs, config: 'C', run: 1,
      prepareProfile: (directories) => mkdir(path.join(directories.store, 'vectors-body.json')) });
    outcome = { failedAsRequired: false, reason: 'the measurement reported success despite the obstructed write' };
  } catch (error) {
    const message = error.message.split('\n')[0];
    outcome = isInducedWriteFailure(message) ? { failedAsRequired: true, error: message }
      : { failedAsRequired: false, reason: 'the measurement failed for an unrelated reason', error: message };
  }
  await writeFile(path.join(out, 'write-failure.json'), `${JSON.stringify(outcome, null, 2)}\n`, { flag: 'wx' });
  return outcome;
}
