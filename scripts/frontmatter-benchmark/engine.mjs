// Renderer-side benchmark engine, bundled for the isolated Electron page. Inference always goes through the
// product LocalEmbeddingProvider and its real Worker; this file orchestrates, persists to an isolated on-disk
// store and records observations (delivered inputs, traces, bytes) without substituting any computation.
import { ChunkPipeline } from '../../src/core/index/chunk-pipeline.ts';
import { ChunkRegistry } from '../../src/core/index/chunk-registry.ts';
import { HybridRetrieval } from '../../src/core/index/hybrid-retrieval.ts';
import { IndexUpdateOrchestrator } from '../../src/core/index/index-update-orchestrator.ts';
import { LocalFullTextSearch } from '../../src/core/index/local-full-text-search.ts';
import { LocalVectorStore } from '../../src/core/index/local-vector-store.ts';
import { chunkMarkdown } from '../../src/core/index/markdown-chunker.ts';
import { RetrievalReranker } from '../../src/core/index/retrieval-reranker.ts';
import { SourceRegistry } from '../../src/core/index/source-registry.ts';
import { LOCAL_MODEL, LOCAL_MODEL_KEY } from '../../src/core/provider/local-embedding-model.ts';
import { LocalEmbeddingProvider } from '../../src/obsidian/local-embedding-provider.ts';
import { canonicalChunks, sha256Text } from './canonical.mjs';
import { MAX_MODEL_TOKENS, projectPrefix, routeQuery } from './search-input.mjs';
import { CANDIDATE_LIMIT, CONTEXT_CHUNKS, FrontmatterSearchIndex, KINDS, indexVersion, rerankTrace } from './search-index.mjs';
import { createFileStore, indexStorage } from './store.mjs';

const TOKENIZER_FILES = ['config.json', 'tokenizer_config.json', 'special_tokens_map.json', 'tokenizer.json'];
const WARMUP_TEXT = 'ローカル埋め込みの初期化確認';
const nodeRequire = Reflect.get(globalThis, 'require');

async function fetchBytes(name) {
  const response = await fetch(`/${name}`);
  if (!response.ok) throw new Error(`Benchmark asset ${name} is unavailable.`);
  return response.arrayBuffer();
}

/** Starts a module worker from a Blob, like the product provider, so every worker shares one environment. */
async function startWorker(name) {
  const url = URL.createObjectURL(new Blob([await fetchBytes(name)], { type: 'text/javascript' }));
  try { return new Worker(url, { type: 'module' }); } finally { URL.revokeObjectURL(url); }
}

function workerClient(worker, label) {
  let nextId = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(`${label}: ${data.error}`));
    else request.resolve(data);
  };
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error(`${label} crashed.`));
    pending.clear();
  };
  return (message, transfer = []) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

class BenchmarkSession {
  /** Loads every asset while the network is still permitted for app:// (local only); no inference happens here. */
  async stage({ config, notes, directories, modelFiles, tokenizerSha256, chunksSha256 }) {
    if (typeof nodeRequire !== 'function') throw new Error('Node integration is required for the isolated store.');
    this.fs = nodeRequire('node:fs/promises');
    this.path = nodeRequire('node:path');
    this.config = config;
    this.notes = notes;
    this.directories = directories;
    this.chunksSha256 = chunksSha256;
    this.version = indexVersion(LOCAL_MODEL_KEY, tokenizerSha256);
    const directory = `models/${LOCAL_MODEL.revision}`;
    const started = performance.now();
    const tokenizerFiles = {};
    for (const name of TOKENIZER_FILES) tokenizerFiles[name] = await fetchBytes(`${directory}/${name}`);
    this.tokenizerWorker = await startWorker('frontmatter-benchmark/tokenizer-worker.js');
    this.tokenizerRequest = workerClient(this.tokenizerWorker, 'Tokenizer worker');
    const { modelMaxLength } = await this.tokenizerRequest({ type: 'init', files: tokenizerFiles });
    const tokenizerInitMs = performance.now() - started;
    this.tokenizerMaxLength = modelMaxLength;
    this.tokenizerCalls = { calls: 0, texts: 0, ms: 0 };
    this.tokenize = async (texts) => {
      const begun = performance.now();
      const { ids } = await this.tokenizerRequest({ type: 'tokenize', texts });
      this.tokenizerCalls.calls += 1;
      this.tokenizerCalls.texts += texts.length;
      this.tokenizerCalls.ms += performance.now() - begun;
      return ids;
    };
    this.models = {};
    for (const file of modelFiles) this.models[file] = await fetchBytes(`${directory}/${file}`);
    const guard = new TextDecoder().decode(await fetchBytes('frontmatter-benchmark/worker-guard.js'));
    this.runtime = {
      script: `globalThis.prismWorkerGuardLog = ${JSON.stringify(directories.workerGuardLog)};\n${guard}\n` +
        new TextDecoder().decode(await fetchBytes('local-embedding-worker.js')),
      factory: new TextDecoder().decode(await fetchBytes('ort-wasm-simd-threaded.jsep.mjs')),
      wasm: await fetchBytes('ort-wasm-simd-threaded.jsep.wasm'),
    };
    this.parityScript = config === 'parity' ? await fetchBytes('frontmatter-benchmark/parity-worker.js') : undefined;
    return { tokenizerInitMs, modelMaxLength, userAgent: navigator.userAgent };
  }

  async networkStatus() {
    const worker = await this.tokenizerRequest({ type: 'status' });
    return { pageOnline: navigator.onLine, worker, rendererNodeGuard: globalThis.prismRendererGuard === true,
      rendererNodeNetwork: [...(globalThis.prismNodeNetwork ?? [])] };
  }

  /** Attempts synthetic external requests through the page, renderer Node and worker; every one must fail. */
  async probe(url) {
    let pageFetch;
    try {
      await fetch(url, { cache: 'no-store' });
      pageFetch = { refused: false };
    } catch (error) {
      pageFetch = { refused: true, error: error.name };
    }
    let rendererNode;
    try {
      nodeRequire('node:net').connect(443, new URL(url).hostname).destroy();
      rendererNode = { refused: false };
    } catch (error) {
      rendererNode = { refused: true, error: error.message };
    }
    return { pageFetch, rendererNode, worker: await this.tokenizerRequest({ type: 'probe', url }) };
  }

  startProvider() {
    const copy = Object.fromEntries(Object.entries(this.models).map(([name, bytes]) => [name, bytes.slice(0)]));
    const runtime = { ...this.runtime, wasm: this.runtime.wasm.slice(0) };
    this.provider = new LocalEmbeddingProvider({ load: async () => copy, loadRuntime: async () => runtime });
    this.inference = { texts: 0, ms: 0, calls: 0 };
    this.capture = null;
    this.embed = async (texts) => {
      if (this.capture) this.capture.push(...texts);
      const begun = performance.now();
      const vectors = await this.provider.embedBatch(texts);
      this.inference.calls += 1;
      this.inference.texts += texts.length;
      this.inference.ms += performance.now() - begun;
      return vectors;
    };
  }

  async warmup() {
    this.startProvider();
    const started = performance.now();
    await this.provider.embedBatch([WARMUP_TEXT]);
    return { initMs: this.provider.metrics.loadMs, warmupMs: performance.now() - started, modelBytes: this.provider.metrics.modelBytes };
  }

  vaultPath(notePath) {
    const absolute = this.path.resolve(this.directories.vault, ...notePath.split('/'));
    const relative = this.path.relative(this.directories.vault, absolute);
    if (!relative || relative.startsWith('..') || this.path.isAbsolute(relative)) throw new Error('Note path escapes the vault.');
    return absolute;
  }

  async openFromStore() {
    this.store = createFileStore(this.fs, this.path, this.directories.store);
    this.sources = await SourceRegistry.open(this.store.storage('sources'));
    this.chunks = await ChunkRegistry.open(this.store.storage('chunks'), this.sources);
    this.pipeline = new ChunkPipeline(this.sources, this.chunks);
    if (this.config === 'M') {
      this.fullText = await LocalFullTextSearch.open(this.store.storage('fulltext'));
      this.vectors = await LocalVectorStore.open(this.store.storage('vectors-body'), LOCAL_MODEL.dimensions);
      this.orchestrator = new IndexUpdateOrchestrator(this.chunks, this.fullText, { embedBatch: this.embed }, async () => this.vectors);
      this.index = undefined;
    } else {
      const storage = indexStorage(this.store);
      this.index = await FrontmatterSearchIndex.open({ config: this.config, version: this.version, chunks: this.chunks,
        sources: this.sources, embed: this.embed, tokenize: this.tokenize, dimensions: LOCAL_MODEL.dimensions,
        persist: (state) => storage.save(state) }, await storage.load());
    }
  }

  async syncSource(sourceId, markdown) {
    await this.pipeline.sync(sourceId, markdown);
    if (this.config === 'M') {
      await this.orchestrator.sync(sourceId);
      return undefined;
    }
    return this.index.sync(sourceId, markdown);
  }

  allChunks() {
    return this.notes.flatMap((note) => this.chunks.listBySource(this.sources.getByPath(note.path).source_id));
  }

  /** Source hashes and chunk records must equal main's chunker output for the given contents. */
  async integrity(contents) {
    const failures = [];
    for (const [notePath, content] of contents) {
      const source = this.sources.getByPath(notePath);
      if (!source || source.content_hash !== await sha256Text(content)) failures.push({ path: notePath, check: 'source-hash' });
      else if (canonicalChunks(this.chunks.listBySource(source.source_id)) !== canonicalChunks(chunkMarkdown(source.source_id, content))) {
        failures.push({ path: notePath, check: 'chunks-match-main' });
      }
    }
    return failures;
  }

  vectorFingerprints() {
    return Object.fromEntries(this.notes.map((note) => {
      const sourceId = this.sources.getByPath(note.path).source_id;
      const entries = this.config === 'M' ? this.vectors.listBySource(sourceId)
        : this.index.entries.filter((entry) => entry.sourceId === sourceId);
      return [note.path, JSON.stringify(entries)];
    }));
  }

  vectorCounts() {
    if (this.config === 'M') {
      return { body: this.notes.reduce((total, note) => total + this.vectors.listBySource(this.sources.getByPath(note.path).source_id).length, 0) };
    }
    return this.index.storedCounts();
  }

  /** Compares the literal texts given to embedBatch with the reported inputs and re-tokenizes each one. */
  async deliveredReport(delivered, expected) {
    const ids = delivered.length ? await this.tokenize(delivered) : [];
    const items = await Promise.all(delivered.map(async (text, index) => ({ sha256: await sha256Text(text), tokens: ids[index].length })));
    const matchesExpected = expected === undefined ? null
      : expected.length === delivered.length && expected.every((item, index) => item.text === delivered[index] &&
        item.projectedTokens === ids[index].length);
    return { count: delivered.length, matchesExpected, maxTokens: Math.max(0, ...items.map((item) => item.tokens)),
      overLimit: items.filter((item) => item.tokens > MAX_MODEL_TOKENS).length, items };
  }

  async persistenceReport() {
    return { readbackMismatches: await this.store.readbackMismatches(), fileBytes: await this.store.fileBytes(),
      serializedBytes: this.store.serializedBytes() };
  }

  async build() {
    this.inference = { texts: 0, ms: 0, calls: 0 };
    this.tokenizerCalls = { calls: 0, texts: 0, ms: 0 };
    this.capture = [];
    const preFileBytes = await createFileStore(this.fs, this.path, this.directories.store).fileBytes();
    const contents = new Map();
    const reports = [];
    // Timed window: store open (frozen source snapshot read), fixture reads, indexing and every awaited write.
    const started = performance.now();
    await this.openFromStore();
    for (const note of this.notes) {
      const content = await this.fs.readFile(this.vaultPath(note.path), 'utf8');
      contents.set(note.path, content);
      const report = await this.syncSource(this.sources.getByPath(note.path).source_id, content);
      if (report) reports.push({ path: note.path, ...report });
    }
    const rebuildMs = performance.now() - started;
    const inference = { ...this.inference };
    const tokenizer = { ...this.tokenizerCalls };
    const deliveredTexts = this.capture;
    this.capture = null;
    const persistence = { pre: preFileBytes, ...await this.persistenceReport() };
    await this.openFromStore();
    if (this.index) await this.index.verify(contents);
    const expected = this.index ? reports.flatMap((report) => report.delivered) : undefined;
    const delivered = await this.deliveredReport(deliveredTexts, expected);
    let inputs;
    if (this.index) {
      const embedded = reports.flatMap((report) => report.inputs.filter((input) => input.embedded).map((input) => ({ path: report.path, input })));
      embedded.forEach(({ input }, index) => { input.delivered = delivered.items[index]; });
      inputs = reports.flatMap((report) => report.inputs.map((input) => ({ path: report.path, ...input })));
    } else {
      // Main embeds raw chunk content and relies on the model's own truncation; counts are recorded, not capped.
      inputs = this.allChunks().map((chunk, index) => ({ path: this.sources.getById(chunk.source_id).path, kind: 'body',
        chunkId: chunk.chunk_id, originalTokens: delivered.items[index]?.tokens ?? null, projectedTokens: null,
        truncated: null, embedded: true, delivered: delivered.items[index] ?? null }));
    }
    const notesCheck = await Promise.all(this.notes.map(async (note) => (await sha256Text(contents.get(note.path))) === note.normalizedSha256));
    await this.fs.rm(this.directories.baseline, { recursive: true, force: true });
    await this.fs.cp(this.directories.store, this.directories.baseline, { recursive: true });
    this.baselineContents = contents;
    return {
      rebuildMs, inference, tokenizer, inputs,
      delivered: { count: delivered.count, matchesExpected: delivered.matchesExpected, maxTokens: delivered.maxTokens, overLimit: delivered.overLimit },
      attributes: reports.map((report) => ({ path: report.path, ...report.attributes })),
      chunks: this.allChunks().length,
      vectorCounts: this.vectorCounts(),
      persistence,
      integrityFailures: [...await this.integrity(contents),
        ...(notesCheck.every(Boolean) ? [] : [{ check: 'vault-notes-match-snapshot' }])],
      registryDigest: await sha256Text(canonicalChunks(this.allChunks())),
      registryMatchesSnapshot: await sha256Text(canonicalChunks(this.allChunks())) === this.chunksSha256,
      sourceIds: Object.fromEntries(this.notes.map((note) => [note.path, this.sources.getByPath(note.path).source_id])),
    };
  }

  resolveGold(question) {
    const source = this.sources.getByPath(question.path);
    const chunk = source && this.chunks.listBySource(source.source_id)
      .find((item) => item.location.startLine <= question.gold.goldLine && question.gold.goldLine <= item.location.endLine);
    const gold = chunk && { sourceId: source.source_id, chunkId: chunk.chunk_id, startLine: chunk.location.startLine, endLine: chunk.location.endLine };
    if (!gold || ['sourceId', 'chunkId', 'startLine', 'endLine'].some((key) => gold[key] !== question.gold[key])) {
      throw new Error(`Gold of ${question.id} differs from the frozen snapshot.`);
    }
    return gold;
  }

  async runQueries(questions) {
    const before = await sha256Text(canonicalChunks(this.allChunks()));
    const legacy = this.config === 'M'
      ? { retrieval: new HybridRetrieval(this.fullText, this.vectors), reranker: new RetrievalReranker((id) => this.chunks.get(id)?.content) }
      : undefined;
    const results = [];
    const deliveredTexts = [];
    const expected = [];
    this.capture = deliveredTexts;
    for (const question of questions) {
      const gold = this.resolveGold(question);
      const route = routeQuery(question.question);
      const timings = {};
      const started = performance.now();
      let mark = started;
      const lap = (name) => { const now = performance.now(); timings[name] = now - mark; mark = now; };
      let queryTokens;
      let stages;
      if (legacy) {
        const [vector] = await this.embed([question.question]);
        lap('embedMs');
        const hybrid = await legacy.retrieval.retrieve(question.question, vector, CANDIDATE_LIMIT);
        lap('retrieveMs');
        const rerank = await legacy.reranker.rerank(question.question, hybrid, CONTEXT_CHUNKS);
        lap('rerankMs');
        timings.totalMs = performance.now() - started;
        stages = { vector: await this.vectors.search(vector, this.vectorCounts().body), hybrid, rerank,
          rerankTrace: await rerankTrace(question.question, hybrid, rerank, (id) => this.chunks.get(id).content) };
        queryTokens = { originalTokens: null, projectedTokens: null, truncated: null };
      } else {
        const input = await this.index.queryInput(question.question);
        lap('tokenizeMs');
        const [vector] = await this.embed([input.text]);
        lap('embedMs');
        const search = await this.index.search(question.question, vector, route);
        lap('searchAndRerankMs');
        timings.totalMs = performance.now() - started;
        expected.push({ text: input.text, projectedTokens: input.projectedTokens });
        queryTokens = { originalTokens: input.originalTokens, projectedTokens: input.projectedTokens,
          discardedTokens: input.discardedTokens, truncated: input.truncated, checkedPrefixes: input.checkedPrefixes };
        stages = { vector: search.vector, hybrid: search.hybrid, rerank: search.rerank, rerankTrace: search.rerankTrace,
          bodyList: search.bodyList, channels: search.channels, metadataWeight: search.weight };
      }
      results.push({ id: question.id, group: question.group, question: question.question, route, gold, queryTokens, timings, stages });
    }
    this.capture = null;
    const delivered = await this.deliveredReport(deliveredTexts, this.index ? expected : undefined);
    results.forEach((result, index) => {
      result.delivered = delivered.items[index];
      if (!this.index) result.queryTokens.originalTokens = delivered.items[index].tokens;
    });
    return { questions: results, registryUnchanged: before === await sha256Text(canonicalChunks(this.allChunks())),
      delivered: { count: delivered.count, matchesExpected: delivered.matchesExpected, maxTokens: delivered.maxTokens, overLimit: delivered.overLimit } };
  }

  /** Applies one scenario's literal edits to the persisted post-build snapshot; edits never accumulate. */
  async runUpdate(scenario, paths, edits) {
    await this.fs.rm(this.directories.store, { recursive: true, force: true });
    await this.fs.cp(this.directories.baseline, this.directories.store, { recursive: true });
    for (const [notePath, content] of this.baselineContents) await this.fs.writeFile(this.vaultPath(notePath), content);
    await this.openFromStore();
    if (this.index) await this.index.verify(this.baselineContents);
    const before = this.vectorFingerprints();
    const chunksBefore = Object.fromEntries(this.notes.map((note) =>
      [note.path, canonicalChunks(this.chunks.listBySource(this.sources.getByPath(note.path).source_id))]));
    const contents = new Map(this.baselineContents);
    for (const notePath of paths) {
      const [oldText, newText] = edits[notePath];
      const content = contents.get(notePath).replace(oldText, newText);
      if (content === contents.get(notePath)) throw new Error(`Scenario ${scenario} did not change ${notePath}.`);
      contents.set(notePath, content);
      await this.fs.writeFile(this.vaultPath(notePath), content);
    }
    this.inference = { texts: 0, ms: 0, calls: 0 };
    this.capture = [];
    const reports = [];
    // Timed window: reading each modified note, registry updates, re-indexing and every awaited write.
    const started = performance.now();
    for (const notePath of paths) {
      const content = await this.fs.readFile(this.vaultPath(notePath), 'utf8');
      const source = this.sources.getByPath(notePath);
      await this.sources.update(source.source_id, { path: notePath, content, mtime: 2, size: new TextEncoder().encode(content).length });
      const report = await this.syncSource(source.source_id, content);
      reports.push({ path: notePath, inferences: report?.inferences ?? null, reused: report?.reused ?? null,
        rekeyed: report?.rekeyed ?? null, removed: report?.removed ?? null, delivered: report?.delivered });
    }
    const ms = performance.now() - started;
    const inference = { ...this.inference };
    const deliveredTexts = this.capture;
    this.capture = null;
    const persistence = await this.persistenceReport();
    await this.openFromStore();
    if (this.index) await this.index.verify(contents);
    const after = this.vectorFingerprints();
    const targets = new Set(paths);
    const delivered = await this.deliveredReport(deliveredTexts, this.index ? reports.flatMap((report) => report.delivered) : undefined);
    const collateralChunks = this.notes.filter((note) => !targets.has(note.path) &&
      canonicalChunks(this.chunks.listBySource(this.sources.getByPath(note.path).source_id)) !== chunksBefore[note.path]);
    return {
      scenario, ms, inference,
      inferencesByKind: this.index ? Object.fromEntries(KINDS.map((kind) =>
        [kind, reports.reduce((total, report) => total + report.inferences[kind], 0)])) : { body: inference.texts },
      reports: reports.map(({ delivered: _delivered, ...report }) => report),
      delivered: { count: delivered.count, matchesExpected: delivered.matchesExpected, maxTokens: delivered.maxTokens,
        overLimit: delivered.overLimit, items: delivered.items },
      otherSourcesChanged: this.notes.filter((note) => !targets.has(note.path) && before[note.path] !== after[note.path])
        .map((note) => note.path),
      integrityFailures: [...await this.integrity(contents), ...collateralChunks.map((note) => ({ path: note.path, check: 'collateral-chunks' }))],
      persistence,
      vectorCounts: this.vectorCounts(),
    };
  }

  /**
   * Parity preflight: compares the separate tokenizer Worker with the IDs the feature-extraction pipeline itself
   * produces, and the parity pipeline's vectors with the product Worker's, on synthetic and fixture texts.
   */
  async runParity({ probes, vectorProbes }) {
    const long = `${'境界のテスト文章です。'.repeat(80)} boundary`;
    const boundary = await projectPrefix(long, MAX_MODEL_TOKENS, this.tokenize);
    const points = [...long];
    const texts = [...probes, boundary.text, points.slice(0, [...boundary.text].length + 1).join(''), long];
    const worker = await (async () => {
      const url = URL.createObjectURL(new Blob([this.parityScript], { type: 'text/javascript' }));
      try { return new Worker(url, { type: 'module' }); } finally { URL.revokeObjectURL(url); }
    })();
    const request = workerClient(worker, 'Parity worker');
    try {
      const models = Object.fromEntries(Object.entries(this.models).map(([name, bytes]) => [name, bytes.slice(0)]));
      const wasm = this.runtime.wasm.slice(0);
      const { modelMaxLength: pipelineMaxLength } = await request({ type: 'init', models, factory: this.runtime.factory, wasm },
        [...Object.values(models), wasm]);
      const encoded = await this.tokenize(texts);
      const { ids: pipelineIds } = await request({ type: 'tokenize', texts });
      const tokenProbes = await Promise.all(texts.map(async (text, index) => {
        const own = encoded[index];
        const pipelineOwn = pipelineIds[index];
        const equal = own.length <= pipelineMaxLength
          ? JSON.stringify(own) === JSON.stringify(pipelineOwn)
          : pipelineOwn.length === pipelineMaxLength &&
            JSON.stringify(own.slice(0, pipelineMaxLength - 1)) === JSON.stringify(pipelineOwn.slice(0, pipelineMaxLength - 1));
        return { sha256: await sha256Text(text), codePoints: [...text].length, tokenizerWorkerTokens: own.length,
          pipelineTokens: pipelineOwn.length, equal };
      }));
      this.startProvider();
      const vectorTexts = [...vectorProbes, boundary.text];
      const product = await this.provider.embedBatch(vectorTexts);
      const { vectors: parity } = await request({ type: 'embed', texts: vectorTexts });
      let maxAbsDiff = 0;
      product.forEach((vector, row) => vector.forEach((value, column) => {
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(value - parity[row][column]));
      }));
      return { pipelineMaxLength, tokenizerMaxLength: this.tokenizerMaxLength, boundaryTokens: boundary.projectedTokens,
        tokenProbes, vectorProbes: vectorTexts.length, maxAbsDiff,
        pass: pipelineMaxLength === MAX_MODEL_TOKENS && this.tokenizerMaxLength === MAX_MODEL_TOKENS &&
          tokenProbes.every((probe) => probe.equal) && maxAbsDiff <= 1e-6 };
    } finally {
      worker.terminate();
    }
  }

  collectGarbage() {
    if (typeof globalThis.gc !== 'function') return false;
    globalThis.gc();
    globalThis.gc();
    return true;
  }

  dispose() {
    this.provider?.dispose();
    this.tokenizerWorker?.terminate();
  }
}

globalThis.prismFrontmatterBenchmark = new BenchmarkSession();
