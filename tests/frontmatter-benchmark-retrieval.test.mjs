import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(relativePath) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    // The browser platform selects the same yaml build that the Electron benchmark bundle uses.
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const { FrontmatterSearchIndex, fuseCandidates, indexVersion, KINDS } = await load('../scripts/frontmatter-benchmark/search-index.mjs');
const { createFileStore, indexStorage } = await load('../scripts/frontmatter-benchmark/store.mjs');
const { SourceRegistry, hashSourceContent } = await load('../src/core/index/source-registry.ts');
const { ChunkRegistry } = await load('../src/core/index/chunk-registry.ts');
const { ChunkPipeline } = await load('../src/core/index/chunk-pipeline.ts');
const { chunkMarkdown } = await load('../src/core/index/markdown-chunker.ts');

// Deterministic plumbing vectors only: counts of three marker words plus a small constant.
const vectorOf = (text) => [...['alpha', 'beta', 'gamma'].map((word) => text.split(word).length - 1), 0.01];
const fakeTokenize = async (texts) => texts.map((text) => [0, ...[...text].map((point) => point.codePointAt(0)), 2]);

function memory(saved) {
  return { load: async () => saved, save: async (value) => { saved = value; } };
}

async function setup(config, notes, indexOptions = {}) {
  const records = await Promise.all(Object.entries(notes).map(async ([path, content], index) => ({
    source_id: `s${index + 1}`, path, content_hash: await hashSourceContent(content), mtime: 1, size: content.length })));
  const sources = await SourceRegistry.open(memory(records));
  const chunks = await ChunkRegistry.open(memory(), sources);
  const pipeline = new ChunkPipeline(sources, chunks);
  const embedded = [];
  const embed = async (texts) => { embedded.push(...texts); return texts.map(vectorOf); };
  const options = { config, version: 'test-version', chunks, sources, embed, tokenize: fakeTokenize, dimensions: 4, ...indexOptions };
  const index = await FrontmatterSearchIndex.open(options);
  const ids = {};
  for (const [path, content] of Object.entries(notes)) {
    const source = sources.getByPath(path);
    ids[path] = source.source_id;
    await pipeline.sync(source.source_id, content);
    if (!options.isExcluded?.(path)) await index.sync(source.source_id, content);
  }
  const contents = new Map(Object.entries(notes));
  await index.verify(contents);
  embedded.length = 0;
  const reopen = (state, overrides = {}) => FrontmatterSearchIndex.open({ ...options, ...overrides }, state);
  const edit = async (path, oldText, newText) => {
    const content = notes[path].replace(oldText, newText);
    assert.notEqual(content, notes[path]);
    await sources.update(ids[path], { path, content, mtime: 2, size: content.length });
    await pipeline.sync(ids[path], content);
    const report = await index.sync(ids[path], content);
    assert.deepEqual(chunks.listBySource(ids[path]), chunkMarkdown(ids[path], content), 'citation chunks equal main');
    assert.equal(sources.getById(ids[path]).content_hash, await hashSourceContent(content));
    return report;
  };
  return { sources, chunks, pipeline, index, ids, embedded, edit, reopen, contents };
}

const bodyHits = Array.from({ length: 20 }, (_, index) => ({ chunkId: `c${String(index + 1).padStart(2, '0')}`, sourceId: 'src' }));
const metadataHits = [
  { chunkId: 'm1', sourceId: 'x', rank: 0 },
  { chunkId: 'c18', sourceId: 'src', rank: 1 },
  { chunkId: 'm2', sourceId: 'y', rank: 5 },
  { chunkId: 'm1', sourceId: 'x', rank: 7 },
];

test('fusion keeps body ranks 1-16 and fills four slots by weighted combined score', () => {
  const explicit = fuseCandidates([bodyHits], metadataHits, 1);
  const implicit = fuseCandidates([bodyHits], metadataHits, 0.25);
  for (const result of [explicit, implicit]) {
    assert.equal(result.candidates.length, 20);
    assert.equal(result.bodyList.length, 20);
    for (const hit of bodyHits.slice(0, 16)) assert.ok(result.candidates.some((item) => item.chunkId === hit.chunkId));
    assert.equal(result.candidates.filter((item) => item.chunkId === 'm1').length, 1, 'duplicate metadata hits dedupe');
    assert.ok(!result.candidates.some((item) => item.chunkId === 'c20'));
  }
  const extra = (result) => result.candidates.map((item) => item.chunkId).filter((id) => !bodyHits.slice(0, 16).some((hit) => hit.chunkId === id));
  assert.deepEqual(new Set(extra(explicit)), new Set(['m1', 'c18', 'm2', 'c17']));
  assert.deepEqual(new Set(extra(implicit)), new Set(['m1', 'c18', 'c17', 'c19']), 'implicit weight 0.25 drops a weak metadata hit');
  assert.deepEqual(explicit.candidates.slice(0, 2).map((item) => item.chunkId), ['c01', 'm1'], 'equal scores tie by sourceId');
  assert.equal(explicit.candidates.find((item) => item.chunkId === 'm1').metadataRank, 1, 'best metadata rank wins');
});

test('fusion rejects a metadata hit whose chunk belongs to another source', () => {
  assert.throws(() => fuseCandidates([bodyHits], [{ chunkId: 'c05', sourceId: 'other', rank: 0 }], 1), /disagree/);
});

test('repeated metadata from one source fills four extras without displacing protected sixteen', () => {
  const repeated = Array.from({ length: 5 }, (_, rank) => ({ chunkId: `m${rank}`, sourceId: 'repeat', rank }));
  const { candidates } = fuseCandidates([bodyHits], repeated, 1);
  assert.equal(candidates.filter((item) => item.protected).length, 16);
  assert.ok(bodyHits.slice(0, 16).every((body) => candidates.some((item) => item.chunkId === body.chunkId)));
  assert.deepEqual(candidates.filter((item) => !item.protected).map((item) => item.sourceId), Array(4).fill('repeat'));
});

test('C searches body projections only, so frontmatter-only words and chunks cannot be retrieved', async () => {
  const { index, chunks, ids } = await setup('C', {
    'one.md': '---\ntitle: gamma\n---\n## One\nalpha alpha',
    'two.md': '## Two\nbeta gamma',
  });
  const result = await index.search('gamma', vectorOf('gamma'), 'explicit');
  const frontmatterChunk = chunks.listBySource(ids['one.md'])[0];
  assert.deepEqual(result.channels.text.map((hit) => hit.sourceId), [ids['two.md']]);
  for (const stage of [result.vector, result.hybrid, result.rerank]) {
    assert.ok(stage.every((hit) => hit.chunkId !== frontmatterChunk.chunk_id));
  }
  assert.equal(result.channels.metadata.length, 0);
  assert.equal(index.storedCounts()['attribute-chunk'], 0);
});

test('A indexes one attribute vector per body chunk and grounds all hits in citable chunks', async () => {
  const { index, chunks, ids } = await setup('A', {
    'one.md': '---\ntitle: gamma\n---\n## One\nalpha\n## Two\nbeta\n## Three\ngamma',
  });
  const bodyIds = chunks.listBySource(ids['one.md']).filter((chunk) => !chunk.content.startsWith('---')).map((chunk) => chunk.chunk_id);
  assert.deepEqual(KINDS, ['body', 'attribute-chunk']);
  assert.deepEqual(index.storedCounts(), { body: 3, 'attribute-chunk': 3 });
  assert.deepEqual(index.entries.filter((entry) => entry.kind === 'attribute-chunk').map((entry) => entry.chunkId), bodyIds);
  const result = await index.search('gamma', vectorOf('gamma'), 'explicit');
  for (const stage of [result.vector, result.hybrid, result.rerank, result.channels.metadata]) {
    for (const candidate of stage) {
      assert.equal(chunks.get(candidate.chunkId).source_id, candidate.sourceId);
      assert.ok(!chunks.get(candidate.chunkId).content.startsWith('---'));
    }
  }
});

test('a stale registry makes the typed index fail with a rebuild error instead of returning partial results', async () => {
  const { index, pipeline, ids } = await setup('A', {
    'one.md': '---\ntitle: alpha\n---\n## One\nalpha',
    'two.md': '---\ntitle: beta\n---\n## Two\nbeta',
  });
  await pipeline.delete(ids['two.md']);
  assert.throws(() => index.validate(), /rebuild/);
  await assert.rejects(index.search('beta', vectorOf('beta'), 'explicit'), /rebuild/);
});

const updateNotes = {
  'target.md': '---\ntitle: First\ntags: [x]\nreviewed: no\n---\nIntro alpha.\n## Beta\nbeta two.',
  'other.md': '---\ntitle: Second\n---\n## Gamma\ngamma.',
};

test('non-indexed frontmatter edits re-key changed chunk IDs without any inference', async () => {
  const { index, chunks, ids, embedded, edit } = await setup('A', updateNotes);
  const report = await edit('target.md', 'reviewed: no', 'reviewed: yes');
  assert.deepEqual(embedded, []);
  assert.equal(report.rekeyed, 2, 'first raw chunk ID changed and its vectors moved');
  index.validate();
  const current = new Set(chunks.listBySource(ids['target.md']).map((chunk) => chunk.chunk_id));
  assert.ok(index.entries.filter((entry) => entry.chunkId && entry.sourceId === ids['target.md'])
    .every((entry) => current.has(entry.chunkId)), 'no orphan IDs remain');
});

test('indexed attribute, body sentence and heading edits re-embed only the affected typed inputs of one source', async () => {
  const cases = [
    ['A', 'title: First', 'title: Primary', { body: 0, 'attribute-chunk': 2 }],
    ['A', 'beta two.', 'beta three.', { body: 1, 'attribute-chunk': 0 }],
    ['A', '## Beta', '## Delta', { body: 1, 'attribute-chunk': 1 }],
  ];
  for (const [config, oldText, newText, expected] of cases) {
    const { index, ids, embedded, edit } = await setup(config, updateNotes);
    const otherBefore = JSON.stringify(index.entries.filter((entry) => entry.sourceId === ids['other.md']));
    const report = await edit('target.md', oldText, newText);
    assert.deepEqual(report.inferences, expected, `${config}: ${oldText}`);
    assert.equal(embedded.length, Object.values(expected).reduce((total, count) => total + count, 0));
    assert.equal(JSON.stringify(index.entries.filter((entry) => entry.sourceId === ids['other.md'])), otherBefore);
    index.validate();
  }
});

test('an indexed attribute fans out across four chunks without touching another note', async () => {
  const notes = { 'target.md': '---\ntags: [old]\n---\n## A\none\n## B\ntwo\n## C\nthree\n## D\nfour',
    'other.md': '---\ntitle: other\n---\n## Other\nbody' };
  const { index, ids, edit, embedded } = await setup('A', notes);
  const other = structuredClone(index.entries.filter((entry) => entry.sourceId === ids['other.md']));
  const result = await edit('target.md', 'tags: [old]', 'tags: [new]');
  assert.deepEqual(result.inferences, { body: 0, 'attribute-chunk': 4 });
  assert.equal(embedded.length, 4);
  assert.deepEqual(index.entries.filter((entry) => entry.sourceId === ids['other.md']), other);
});

const verifyNotes = {
  'one.md': '---\ntitle: alpha\n---\n## One\nalpha one\n## Two\nbeta two',
  'two.md': '---\ntitle: beta\n---\n## Three\ngamma three',
};

test('a reopened, legacy, partial or stale typed index fails closed with a rebuild error', async () => {
  const { index, reopen, contents } = await setup('A', verifyNotes);
  const state = index.exportState();
  await assert.rejects(reopen(state, { version: 'older-version' }), /another version/);
  assert.doesNotMatch(indexVersion('model', 'tokenizer'), /note-512/);
  const legacy = structuredClone(state);
  legacy.entries.push({ ...legacy.entries[0], kind: 'attribute-note' });
  await assert.rejects((await reopen(legacy)).verify(contents), /rebuild/);
  const unverified = await reopen(state);
  await assert.rejects(unverified.search('alpha', vectorOf('alpha'), 'explicit'), /without verification/);
  await unverified.verify(contents);
  assert.ok((await unverified.search('alpha', vectorOf('alpha'), 'explicit')).hybrid.length > 0);

  const partial = structuredClone(state);
  partial.entries = partial.entries.filter((entry) => entry.kind !== 'attribute-chunk' || entry.sourceId !== 's2');
  await assert.rejects((await reopen(partial)).verify(contents), /missing, extra or stale/);
  const wrongHash = structuredClone(state);
  wrongHash.entries[0].inputHash = 'f'.repeat(64);
  await assert.rejects((await reopen(wrongHash)).verify(contents), /missing, extra or stale/);
  const staleText = structuredClone(state);
  staleText.fullText = staleText.fullText.slice(1);
  await assert.rejects((await reopen(staleText)).verify(contents), /full-text/);

  // A corrupt entry that would never rank in the top hits still blocks retrieval.
  const lowest = index.entries.findLast((entry) => entry.kind === 'attribute-chunk');
  lowest.values = [Number.NaN, 0, 0, 1];
  await assert.rejects(index.search('alpha', vectorOf('alpha'), 'explicit'), /invalid; rebuild/);
});

test('excluded sources are never indexed, and stored entries for them fail verification', async () => {
  const excluded = (notePath) => notePath === 'two.md';
  const { index, ids, reopen, contents } = await setup('A', verifyNotes, { isExcluded: excluded });
  assert.ok(index.entries.every((entry) => entry.sourceId !== ids['two.md']));
  await assert.rejects(index.sync(ids['two.md'], verifyNotes['two.md']), /Excluded/);
  const included = await setup('A', verifyNotes);
  const leaked = await reopen(included.index.exportState());
  await assert.rejects(leaked.verify(contents), /invalid; rebuild/);
});

test('B config cannot open an index', async () => {
  const { reopen } = await setup('A', verifyNotes);
  await assert.rejects(reopen(undefined, { config: 'B' }), /Unknown search config/);
});

test('equal attribute inputs retain distinct chunk keys and stable chunk ID ties', async () => {
  const { index, ids, chunks } = await setup('A', { 'one.md': '---\ntitle: alpha\n---\n## Same\nbeta\n## Same\nbeta' });
  const expected = chunks.listBySource(ids['one.md']).filter((chunk) => chunk.content.startsWith('## Same'))
    .map((chunk) => chunk.chunk_id).sort();
  const entries = index.entries.filter((entry) => entry.kind === 'attribute-chunk');
  assert.deepEqual(entries.map((entry) => entry.chunkId).sort(), expected);
  index.validate();
  const first = await index.search('alpha', vectorOf('alpha'), 'explicit');
  const second = await index.search('alpha', vectorOf('alpha'), 'explicit');
  assert.deepEqual(first.channels.metadata.map((item) => item.chunkId), expected);
  assert.deepEqual(second.channels.metadata, first.channels.metadata);
});

test('the rerank trace lists all candidates with lexical scores and matches the reranker output', async () => {
  const { index } = await setup('A', verifyNotes);
  const result = await index.search('beta two', vectorOf('beta'), 'explicit');
  assert.equal(result.rerankTrace.length, result.hybrid.length);
  assert.deepEqual(result.rerankTrace.map((item) => item.chunkId), result.hybrid.map((item) => item.chunkId));
  const ranked = result.rerankTrace.filter((item) => item.finalRank !== null).sort((a, b) => a.finalRank - b.finalRank);
  assert.deepEqual(ranked.map((item) => item.chunkId), result.rerank.map((item) => item.chunkId));
  assert.ok(result.rerankTrace.every((item) => Number.isFinite(item.lexicalScore) && Array.isArray(item.channelRanks)));
});

test('index state persisted to an isolated directory reads back identically and a failed write rejects the sync', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-fmb-store-'));
  try {
    const store = createFileStore(fs, path, directory);
    const storage = indexStorage(store);
    const { index, reopen, contents, ids } = await setup('A', verifyNotes, { persist: (state) => storage.save(state) });
    assert.deepEqual(await store.readbackMismatches(), []);
    const bytes = await store.fileBytes();
    for (const name of ['index-meta', 'fulltext', 'vectors-body', 'vectors-attribute-chunk']) {
      assert.ok(bytes[name] > 0, name);
    }
    assert.equal(bytes['vectors-attribute-note'], undefined);
    const reloaded = await reopen(await indexStorage(createFileStore(fs, path, directory)).load());
    await reloaded.verify(contents);
    assert.deepEqual(reloaded.storedCounts(), index.storedCounts());

    await store.write('vectors-attribute-note', []);
    await assert.rejects(indexStorage(createFileStore(fs, path, directory)).load(), /rebuild/);

    await fs.rm(path.join(directory, 'vectors-body.json'));
    await fs.mkdir(path.join(directory, 'vectors-body.json'));
    await assert.rejects(index.sync(ids['one.md'], verifyNotes['one.md']));
    await assert.rejects(index.search('alpha', vectorOf('alpha'), 'explicit'), /without verification/,
      'a failed persist leaves the index unpublished for search');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the write-failure smoke accepts only the induced body-vector rename failure', async () => {
  const { isInducedWriteFailure } = await import('../scripts/frontmatter-benchmark/live.mjs');
  const store = 'C:\\tmp\\prism-fmb-x\\store';
  assert.equal(isInducedWriteFailure(`page.evaluate: Error: EPERM: operation not permitted, rename '${store}\\vectors-body.json.tmp' -> '${store}\\vectors-body.json'`), true);
  assert.equal(isInducedWriteFailure("page.evaluate: Error: EISDIR: illegal operation on a directory, rename '/s/vectors-body.json.tmp' -> '/s/vectors-body.json'"), true);
  for (const unrelated of [
    'page.evaluate: Error: EISDIR: illegal operation on a directory, read',
    `page.evaluate: Error: EPERM: operation not permitted, rename '${store}\\chunks.json.tmp' -> '${store}\\chunks.json'`,
    'Pinned model file onnx/model_quantized.onnx is missing or invalid; this gate is BLOCKED (no download is attempted).',
    'page.evaluate: Error: Local embedding timed out. Free memory, restart Prism, and retry.',
    'electron.launch: Timeout 30000ms exceeded.',
  ]) assert.equal(isInducedWriteFailure(unrelated), false, unrelated);
});
