// Derived search index for configs C/A. Body and attribute-chunk vectors are typed and keyed
// separately; every hit is mapped back to an existing ChunkRegistry chunk before it can reach the reranker.
// Search refuses to run unless the whole index was verified against the current sources since its last change.
import { LocalFullTextSearch } from '../../src/core/index/local-full-text-search.ts';
import { RetrievalReranker, lexicalCandidateScorer } from '../../src/core/index/retrieval-reranker.ts';
import { hashSourceContent } from '../../src/core/index/source-registry.ts';
import { MAX_MODEL_TOKENS, projectPrefix, sourceModelInputs } from './search-input.mjs';

export const INDEX_VERSION = 'fm-search-v2';
export const CHANNEL_LIMIT = 60;
export const CANDIDATE_LIMIT = 20;
export const PROTECTED_BODY_CANDIDATES = 16;
export const CONTEXT_CHUNKS = 6;
export const IMPLICIT_METADATA_WEIGHT = 0.25;
export const KINDS = ['body', 'attribute-chunk'];

const REBUILD = 'rebuild the index';

export function indexVersion(modelKey, tokenizerSha256) {
  return `${INDEX_VERSION}|model:${modelKey}|tokenizer:${tokenizerSha256}` +
    '|projection:body-prefix-512,attribute-384+heading-512|fusion:rr60-meta-w1/0.25-guard16+4';
}

export function compareIds(a, b) {
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  const left = a.chunkId ?? '';
  const right = b.chunkId ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareHits(a, b) {
  return b.score - a.score || compareIds(a, b);
}

function norm(values) {
  let result = 0;
  for (const value of values) result = Math.hypot(result, value);
  return result;
}

function cosine(query, queryNorm, values) {
  const valuesNorm = norm(values);
  let score = 0;
  for (let index = 0; index < query.length; index += 1) score += (values[index] / valuesNorm) * (query[index] / queryNorm);
  return score;
}

function entryKey(entry) {
  return entry.kind === 'body' ? `body\0${entry.chunkId}`
    : `attribute-chunk\0${entry.sourceId}\0${entry.chunkId}`;
}

/**
 * Frozen fusion: body channels contribute 1/(rank+1); metadata hits contribute weight/(rank+1) using their
 * best rank. Body ranks 1-16 are always kept; at most four further slots go to the best combined scores among
 * body ranks 17-20 and metadata hits. Ties use (sourceId, chunkId).
 */
export function fuseCandidates(bodyChannels, metadataHits, weight) {
  const body = new Map();
  bodyChannels.forEach((hits, channel) => {
    hits.forEach((hit, rank) => {
      const existing = body.get(hit.chunkId);
      if (existing && existing.sourceId !== hit.sourceId) {
        throw new Error('Search indexes disagree about a chunk source; rebuild the indexes.');
      }
      const channelRanks = existing?.channelRanks ?? bodyChannels.map(() => null);
      channelRanks[channel] = rank + 1;
      body.set(hit.chunkId, { chunkId: hit.chunkId, sourceId: hit.sourceId, score: (existing?.score ?? 0) + 1 / (rank + 1), channelRanks });
    });
  });
  const metadata = new Map();
  for (const hit of metadataHits) {
    const existing = metadata.get(hit.chunkId) ?? body.get(hit.chunkId);
    if (existing && existing.sourceId !== hit.sourceId) {
      throw new Error('Search indexes disagree about a chunk source; rebuild the indexes.');
    }
    const best = metadata.get(hit.chunkId);
    if (!best || hit.rank < best.rank) metadata.set(hit.chunkId, { sourceId: hit.sourceId, rank: hit.rank });
  }
  const bodyList = [...body.values()].sort(compareHits).slice(0, CANDIDATE_LIMIT);
  const bodyRank = new Map(bodyList.map((hit, index) => [hit.chunkId, index + 1]));
  const scored = (chunkId, sourceId) => {
    const bodyScore = body.get(chunkId)?.score ?? 0;
    const meta = metadata.get(chunkId);
    const metadataScore = meta ? weight / (meta.rank + 1) : 0;
    return { chunkId, sourceId, score: bodyScore + metadataScore, bodyScore, metadataScore,
      channelRanks: body.get(chunkId)?.channelRanks ?? bodyChannels.map(() => null),
      bodyListRank: bodyRank.get(chunkId) ?? null, metadataRank: meta ? meta.rank + 1 : null };
  };
  const kept = bodyList.slice(0, PROTECTED_BODY_CANDIDATES).map((hit) => ({ ...scored(hit.chunkId, hit.sourceId), protected: true }));
  const keptIds = new Set(kept.map((hit) => hit.chunkId));
  const pool = new Map();
  for (const hit of bodyList.slice(PROTECTED_BODY_CANDIDATES)) pool.set(hit.chunkId, hit.sourceId);
  for (const [chunkId, { sourceId }] of metadata) if (!keptIds.has(chunkId)) pool.set(chunkId, sourceId);
  const extra = [...pool].map(([chunkId, sourceId]) => ({ ...scored(chunkId, sourceId), protected: false })).sort(compareHits)
    .slice(0, CANDIDATE_LIMIT - PROTECTED_BODY_CANDIDATES);
  return { bodyList, candidates: [...kept, ...extra].sort(compareHits) };
}

function memoryStorage(saved) {
  const storage = { saved, load: async () => storage.saved, save: async (value) => { storage.saved = value; } };
  return storage;
}

export class FrontmatterSearchIndex {
  constructor(options, fullTextStorage, fullText, state) {
    this.config = options.config;
    this.version = options.version;
    this.chunks = options.chunks;
    this.sources = options.sources;
    this.embed = options.embed;
    this.tokenize = options.tokenize;
    this.dimensions = options.dimensions;
    this.persist = options.persist ?? (async () => {});
    this.isExcluded = options.isExcluded ?? (() => false);
    this.fullTextStorage = fullTextStorage;
    this.fullText = fullText;
    this.entries = state.entries;
    this.projections = new Map(state.projections);
    this.generation = 0;
    this.verifiedGeneration = -1;
    this.reranker = new RetrievalReranker((chunkId) => this.projections.get(chunkId)?.text);
  }

  /**
   * Options: config (C|A), version, chunks, sources, embed(texts), tokenize(texts), dimensions, optional
   * persist(state) awaited after every change and isExcluded(path). A stored state of another version is rejected.
   */
  static async open(options, state) {
    if (!['C', 'A'].includes(options.config)) throw new Error('Unknown search config.');
    const copy = state ? structuredClone(state) : { version: options.version, entries: [], projections: [], fullText: undefined };
    if (copy.version !== options.version || !Array.isArray(copy.entries) || !Array.isArray(copy.projections)) {
      throw new Error(`Stored search index has another version or shape; ${REBUILD}.`);
    }
    const storage = memoryStorage(copy.fullText);
    return new FrontmatterSearchIndex(options, storage, await LocalFullTextSearch.open(storage), copy);
  }

  exportState() {
    return structuredClone({ version: this.version, entries: this.entries, projections: [...this.projections],
      fullText: this.fullTextStorage.saved });
  }

  async desiredInputs(sourceId, markdown) {
    const inputs = await sourceModelInputs(this.config, markdown, this.chunks.listBySource(sourceId), this.tokenize);
    const desired = [
      ...inputs.body.map((item) => ({ kind: 'body', sourceId, chunkId: item.chunkId, input: item.input })),
      ...inputs.metadata.map((item) => ({ kind: item.kind, sourceId, chunkId: item.chunkId, input: item.input,
        coverage: item.coverage })),
    ];
    for (const item of desired) {
      item.inputHash = await hashSourceContent(`${this.version}\0${item.kind}\0${item.input.ids.join(',')}`);
    }
    return { inputs, desired };
  }

  /** Re-derives this source's inputs; unchanged typed inputs are reused (and re-keyed) without inference. */
  async sync(sourceId, markdown) {
    const source = this.sources.getById(sourceId);
    if (!source) throw new Error('Source is not registered.');
    if (this.isExcluded(source.path)) throw new Error('Excluded sources cannot be indexed.');
    this.generation += 1;
    const { inputs, desired } = await this.desiredInputs(sourceId, markdown);
    const unused = this.entries.filter((entry) => entry.sourceId === sourceId);
    const pending = [];
    const next = desired.map((item) => {
      const index = unused.findIndex((entry) => entry.kind === item.kind && entry.inputHash === item.inputHash);
      const entry = { kind: item.kind, sourceId, ...(item.chunkId ? { chunkId: item.chunkId } : {}),
        inputHash: item.inputHash, tokens: item.input.projectedTokens, values: undefined };
      if (index >= 0) {
        const [reused] = unused.splice(index, 1);
        entry.values = reused.values;
        item.reuse = reused.chunkId === item.chunkId ? 'unchanged' : 'rekeyed';
      } else {
        pending.push({ item, entry });
      }
      return entry;
    });
    const vectors = pending.length ? await this.embed(pending.map(({ item }) => item.input.text)) : [];
    if (vectors.length !== pending.length) throw new Error('Embedding provider returned the wrong number of vectors.');
    pending.forEach(({ entry }, index) => {
      const values = vectors[index];
      const magnitude = Array.isArray(values) && values.length === this.dimensions ? norm(values) : NaN;
      if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('Embedding provider returned an invalid vector.');
      entry.values = [...values];
    });
    this.entries = [...this.entries.filter((entry) => entry.sourceId !== sourceId), ...next];
    for (const [chunkId, item] of this.projections) if (item.sourceId === sourceId) this.projections.delete(chunkId);
    for (const item of inputs.body) this.projections.set(item.chunkId, { sourceId, text: item.projection });
    await this.fullText.deleteBySource(sourceId);
    await this.fullText.index(inputs.body.map((item) => ({ chunk_id: item.chunkId, source_id: sourceId, content: item.projection })));
    await this.persist(this.exportState());
    const inferences = Object.fromEntries(KINDS.map((kind) => [kind, pending.filter(({ item }) => item.kind === kind).length]));
    return {
      sourceId,
      attributes: { status: inputs.attributes.status, diagnostic: inputs.attributes.diagnostic,
        fields: inputs.attributes.fields.map((field) => field.field) },
      inferences,
      reused: desired.filter((item) => item.reuse === 'unchanged').length,
      rekeyed: desired.filter((item) => item.reuse === 'rekeyed').length,
      removed: unused.length,
      delivered: pending.map(({ item }) => ({ kind: item.kind, chunkId: item.chunkId ?? null, text: item.input.text,
        projectedTokens: item.input.projectedTokens })),
      inputs: desired.map((item) => ({ kind: item.kind, chunkId: item.chunkId ?? null, inputHash: item.inputHash,
        originalTokens: item.input.originalTokens, projectedTokens: item.input.projectedTokens,
        discardedTokens: item.input.discardedTokens, truncated: item.input.truncated, checkedPrefixes: item.input.checkedPrefixes,
        embedded: pending.some((entry) => entry.item === item), ...(item.coverage ? { coverage: item.coverage } : {}) })),
    };
  }

  async delete(sourceId) {
    this.generation += 1;
    this.entries = this.entries.filter((entry) => entry.sourceId !== sourceId);
    for (const [chunkId, item] of this.projections) if (item.sourceId === sourceId) this.projections.delete(chunkId);
    await this.fullText.deleteBySource(sourceId);
    await this.persist(this.exportState());
  }

  /** Structural check of every entry: unique typed keys, finite dimensioned vectors and live body-bearing chunks. */
  validate() {
    const keys = new Set();
    for (const entry of this.entries) {
      const key = entryKey(entry);
      if (!KINDS.includes(entry.kind) || keys.has(key)) throw new Error(`Typed index keys are invalid; ${REBUILD}.`);
      keys.add(key);
      const source = this.sources.getById(entry.sourceId);
      if (!Array.isArray(entry.values) || entry.values.length !== this.dimensions ||
          entry.values.some((value) => typeof value !== 'number' || !Number.isFinite(value)) || norm(entry.values) === 0 ||
          !/^[a-f0-9]{64}$/.test(entry.inputHash) || !source || this.isExcluded(source.path)) {
        throw new Error(`Typed index entry is invalid; ${REBUILD}.`);
      }
      const chunk = this.chunks.get(entry.chunkId);
      if (!chunk || chunk.source_id !== entry.sourceId || this.projections.get(entry.chunkId)?.sourceId !== entry.sourceId) {
        throw new Error(`Typed index entry has no body-bearing chunk; ${REBUILD}.`);
      }
    }
    if (this.config === 'C' && this.entries.some((entry) => entry.kind !== 'body')) throw new Error('C stores only body vectors.');
  }

  /**
   * Proves the stored index equals what the current sources require: the exact typed key set with content-derived
   * input hashes, body projections and full-text entries. Missing, extra or stale entries fail closed.
   */
  async verify(contents) {
    this.validate();
    const expected = new Map();
    const projections = new Map();
    for (const source of this.sources.list()) {
      if (this.isExcluded(source.path)) continue;
      const markdown = contents.get(source.path);
      if (markdown === undefined) throw new Error(`Source text is unavailable for index verification; ${REBUILD}.`);
      const { inputs, desired } = await this.desiredInputs(source.source_id, markdown);
      for (const item of desired) expected.set(entryKey(item), item.inputHash);
      for (const item of inputs.body) projections.set(item.chunkId, JSON.stringify({ sourceId: source.source_id, text: item.projection }));
    }
    const stored = new Map(this.entries.map((entry) => [entryKey(entry), entry.inputHash]));
    if (stored.size !== expected.size || [...expected].some(([key, hash]) => stored.get(key) !== hash)) {
      throw new Error(`Typed index does not match the current sources (missing, extra or stale entries); ${REBUILD}.`);
    }
    const actualProjections = new Map([...this.projections].map(([chunkId, item]) =>
      [chunkId, JSON.stringify({ sourceId: item.sourceId, text: item.text })]));
    const fullText = new Map((this.fullTextStorage.saved ?? []).map((entry) =>
      [entry.chunkId, JSON.stringify({ sourceId: entry.sourceId, text: entry.content })]));
    for (const actual of [actualProjections, fullText]) {
      if (actual.size !== projections.size || [...projections].some(([chunkId, value]) => actual.get(chunkId) !== value)) {
        throw new Error(`Body projections or full-text entries are stale; ${REBUILD}.`);
      }
    }
    this.verifiedGeneration = this.generation;
  }

  storedCounts() {
    return Object.fromEntries(KINDS.map((kind) => [kind, this.entries.filter((entry) => entry.kind === kind).length]));
  }

  ensureCandidate(hit) {
    const chunk = this.chunks.get(hit.chunkId);
    const source = this.sources.getById(hit.sourceId);
    if (!chunk || chunk.source_id !== hit.sourceId || !source || this.isExcluded(source.path) ||
        this.projections.get(hit.chunkId)?.sourceId !== hit.sourceId) {
      throw new Error(`Search index and registries disagree; ${REBUILD}.`);
    }
  }

  /** Projects an over-length query to the model limit; the returned text is embedded exactly once. */
  async queryInput(query) {
    return projectPrefix(query, MAX_MODEL_TOKENS, this.tokenize);
  }

  async search(query, vector, route) {
    if (this.verifiedGeneration !== this.generation) throw new Error(`Search index changed without verification; ${REBUILD}.`);
    this.validate();
    const queryNorm = norm(vector);
    if (vector.length !== this.dimensions || !Number.isFinite(queryNorm) || queryNorm === 0) {
      throw new Error('A nonzero finite query vector is required.');
    }
    const scored = (kind) => this.entries.filter((entry) => entry.kind === kind)
      .map((entry) => ({ chunkId: entry.chunkId, sourceId: entry.sourceId, score: cosine(vector, queryNorm, entry.values) }))
      .sort(compareHits);
    const textHits = (await this.fullText.search(query, this.projections.size)).sort(compareHits).slice(0, CHANNEL_LIMIT);
    const bodyVector = scored('body').slice(0, CHANNEL_LIMIT);
    let metadata = [];
    let metadataChannel = [];
    if (this.config === 'A') {
      metadataChannel = scored('attribute-chunk').slice(0, CHANNEL_LIMIT);
      metadata = metadataChannel.map((hit, rank) => ({ chunkId: hit.chunkId, sourceId: hit.sourceId, rank }));
    }
    const weight = route === 'explicit' ? 1 : IMPLICIT_METADATA_WEIGHT;
    const hybrid = fuseCandidates([textHits, bodyVector], metadata, weight);
    const vectorOnly = fuseCandidates([bodyVector], metadata, weight);
    for (const hit of [...hybrid.candidates, ...vectorOnly.candidates]) this.ensureCandidate(hit);
    const reranked = await this.reranker.rerank(query, hybrid.candidates, CONTEXT_CHUNKS);
    const trace = await rerankTrace(query, hybrid.candidates, reranked, (chunkId) => this.projections.get(chunkId).text);
    return {
      weight,
      channels: { text: textHits, bodyVector, metadata: metadataChannel },
      bodyList: hybrid.bodyList,
      vector: vectorOnly.candidates,
      hybrid: hybrid.candidates,
      rerank: reranked,
      rerankTrace: trace,
    };
  }
}

/**
 * Lexical score and final position for every candidate passed to the reranker (incoming order breaks ties).
 * Throws if the product reranker's output differs from this trace, e.g. after a silent fallback.
 */
export async function rerankTrace(query, candidates, reranked, contentOf) {
  const scores = await lexicalCandidateScorer(query, candidates.map((hit) => ({ ...hit, content: contentOf(hit.chunkId) })));
  const order = candidates.map((hit, index) => ({ index, score: scores[index] }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const finalRank = new Map(order.slice(0, CONTEXT_CHUNKS).map((item, rank) => [item.index, rank + 1]));
  if (order.slice(0, reranked.length).some((item, rank) => candidates[item.index].chunkId !== reranked[rank].chunkId) ||
      reranked.length !== Math.min(CONTEXT_CHUNKS, candidates.length)) {
    throw new Error('Reranker output does not match its lexical trace.');
  }
  return candidates.map((hit, index) => ({ ...hit, incomingRank: index + 1, lexicalScore: scores[index],
    finalRank: finalRank.get(index) ?? null }));
}
