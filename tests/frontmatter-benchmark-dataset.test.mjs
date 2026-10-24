import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { combinedLoaderHash, loadDataset, sha256, sourceIdFor, validateUpdateProtocol } from '../scripts/frontmatter-benchmark/dataset.mjs';
import { bindDataset, buildSnapshot, readSnapshot } from '../scripts/frontmatter-benchmark/snapshot.mjs';

async function load(relativePath) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const { chunkMarkdown } = await load('../src/core/index/markdown-chunker.ts');
const { SourceRegistry } = await load('../src/core/index/source-registry.ts');
const ORIGINAL = fileURLToPath(new URL('../scripts/frontmatter-benchmark/fixtures/original', import.meta.url));
const HISTORICAL_COMBINED = '04ff9922a0e467721d8cdd81363688d7da396c5af205d9d8fe71807b167c24d1';

async function temporary() {
  return mkdtemp(path.join(os.tmpdir(), 'prism-fmb-dataset-'));
}

async function frozen(root, hash, name = 'test') {
  const snapshot = buildSnapshot(name, await loadDataset(root, hash), chunkMarkdown);
  const file = path.join(await temporary(), 'snapshot.json');
  const text = `${JSON.stringify(snapshot)}\n`;
  await writeFile(file, text);
  return { file, sha: sha256(text), snapshot };
}

test('the recovered original fixture replays the historical combined loader hash and its manifest', async () => {
  const dataset = await loadDataset(ORIGINAL, HISTORICAL_COMBINED);
  assert.equal(dataset.notes.length, 24);
  assert.equal(dataset.questions.length, 48);
  assert.equal(dataset.digests.questionsJsonSha256, '921cfeb2758a155e756dc023fca4f65d48c25e342c49b3f2897a207de6d70d42');
  assert.equal(dataset.digests.fixtureManifestSha256, sha256(await readFile(path.join(ORIGINAL, 'manifest.json'))));
  for (const group of ['attribute', 'body', 'similar', 'plain']) {
    assert.equal(dataset.questions.filter((question) => question.group === group).length, 12);
  }
  for (const question of dataset.questions) {
    assert.equal(question.resolution, 'section');
    assert.equal(question.goldLine, question.sectionLine);
  }
  const note = dataset.updates.notes[0];
  assert.deepEqual(dataset.updates.edits.nonTargetFrontmatter[note], ['\n---\n', '\nreviewed: 2026-10-19\nreviewed_by: ops-bot\n---\n']);
  assert.deepEqual(dataset.updates.edits.indexedAttribute[note], ['tags: [', 'tags: [要確認, ']);
});

test('a changed fixture or wrong expected hash blocks the experiment', async () => {
  await assert.rejects(loadDataset(ORIGINAL, '0'.repeat(64)), /blocked/);
  await assert.rejects(loadDataset(ORIGINAL, undefined), /expected combined/);
});

test('the frozen original snapshot captures main chunks and gold once and binds every run input to them', async () => {
  const { file, sha, snapshot } = await frozen(ORIGINAL, HISTORICAL_COMBINED, 'original');
  try {
    const loaded = await readSnapshot(file, sha);
    const contents = await loadDataset(ORIGINAL, HISTORICAL_COMBINED);
    const inputs = bindDataset(loaded, contents, chunkMarkdown);
    assert.deepEqual(inputs.sourceRecords, snapshot.sources, 'runs use the frozen records');
    for (const record of snapshot.sources) {
      const content = contents.notes.find((note) => note.path === record.path).content;
      assert.deepEqual(snapshot.chunks.filter((chunk) => chunk.source_id === record.source_id), chunkMarkdown(record.source_id, content));
    }
    for (const [index, question] of contents.questions.entries()) {
      const gold = snapshot.gold[index];
      const chunk = snapshot.chunks.find((item) => item.chunk_id === gold.chunkId);
      assert.ok(gold.startLine <= question.sectionLine && question.sectionLine <= gold.endLine);
      assert.ok(chunk.content.split('\n').includes(question.section ?? contents.notes
        .find((note) => note.path === question.path).content.split('\n')[question.sectionLine - 1]));
    }
    assert.equal(inputs.binding.snapshotSha256, sha);
  } finally {
    await rm(path.dirname(file), { recursive: true, force: true });
  }
});

test('snapshot hashes, tampered records and changed questions block evidence', async () => {
  const { file, sha, snapshot } = await frozen(ORIGINAL, HISTORICAL_COMBINED);
  try {
    await assert.rejects(readSnapshot(file, '1'.repeat(64)), /recorded SHA-256/);
    const tampered = structuredClone(snapshot);
    tampered.chunks[0].content += ' changed';
    const tamperedText = JSON.stringify(tampered);
    await writeFile(file, tamperedText);
    await assert.rejects(readSnapshot(file, sha256(tamperedText)), /digests/);
    const reordered = structuredClone(snapshot);
    const dataset = await loadDataset(ORIGINAL, HISTORICAL_COMBINED);
    dataset.questions.reverse();
    assert.throws(() => bindDataset({ ...reordered, sha256: sha }, dataset, chunkMarkdown), /questions differs/);
  } finally {
    await rm(path.dirname(file), { recursive: true, force: true });
  }
});

test('a rename keeps the captured source ID instead of re-deriving it from the new path', async () => {
  const { file, snapshot } = await frozen(ORIGINAL, HISTORICAL_COMBINED);
  await rm(path.dirname(file), { recursive: true, force: true });
  let saved = structuredClone(snapshot.sources);
  const registry = await SourceRegistry.open({ load: async () => saved, save: async (value) => { saved = value; } });
  const [first] = snapshot.sources;
  await registry.movePaths(first.path, 'renamed/moved.md');
  assert.equal(registry.getByPath('renamed/moved.md').source_id, first.source_id);
  assert.notEqual(first.source_id, sourceIdFor('renamed/moved.md'));
});

async function heldoutShaped(mutate = (value) => value, { manifest = true } = {}) {
  const root = await temporary();
  const extra = ['c', 'd', 'e'].map((name) => ({ path: `${name}.md`, content: `---\ntitle: Synthetic ${name}\n---\n## Part\nsentence ${name} one.\n` }));
  const notes = [
    { path: 'a.md', content: '---\ntitle: Synthetic A\ntags: [one]\n---\n## First\nline one\n## Second\nline two\n' },
    ...extra,
    { path: 'sub/b.md', content: '## Plain\nno metadata here\n' },
  ];
  const files = {};
  for (const note of notes) {
    await mkdir(path.dirname(path.join(root, 'corpus', note.path)), { recursive: true });
    await writeFile(path.join(root, 'corpus', note.path), note.content);
    files[`corpus/${note.path}`] = sha256(note.content);
  }
  const parsed = mutate({
    questions: [
      { id: 'h-1', group: 'body', question: 'what is on line two?', path: 'a.md', section: '## Second', goldLine: 8 },
      { id: 'h-2', group: 'plain', question: 'plain note?', path: 'sub/b.md', section: '## Plain', goldLine: 2 },
    ],
    updateScenarios: {
      notes: ['a.md', 'c.md', 'd.md', 'e.md'],
      excludedEdits: { 'a.md': ['tags: [one]', 'tags: [one]\nreviewed: yes'], ...Object.fromEntries(['c', 'd', 'e'].map((name) =>
        [`${name}.md`, [`title: Synthetic ${name}`, `title: Synthetic ${name}\nreviewed: yes`]])) },
      attributeEdits: { 'a.md': ['title: Synthetic A', 'title: Synthetic AA'], ...Object.fromEntries(['c', 'd', 'e'].map((name) =>
        [`${name}.md`, [`title: Synthetic ${name}`, `title: Synthetic ${name}${name}`]])) },
      bodyEdits: { 'a.md': ['line one', 'line one changed'], ...Object.fromEntries(['c', 'd', 'e'].map((name) =>
        [`${name}.md`, [`sentence ${name} one.`, `sentence ${name} one, edited.`]])) },
    },
  });
  const questions = JSON.stringify(parsed);
  await writeFile(path.join(root, 'questions.json'), questions);
  files['questions.json'] = sha256(questions);
  if (manifest) await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ files }));
  return { root, notes, hash: combinedLoaderHash(notes, parsed.questions, parsed.updateScenarios) };
}

test('the update protocol needs exactly four distinct eligible notes with frontmatter-only and one-line body edits', async () => {
  const plainEdits = (value) => {
    for (const map of ['excludedEdits', 'attributeEdits', 'bodyEdits']) value.updateScenarios[map]['sub/b.md'] = ['no metadata', 'no metadata x'];
  };
  const cases = [
    [(value) => { value.updateScenarios.notes.pop(); return value; }, /exactly 4 distinct notes; found 3/],
    [(value) => { value.updateScenarios.notes.push('sub/b.md'); plainEdits(value); return value; }, /exactly 4 distinct notes; found 5/],
    [(value) => { value.updateScenarios.notes[3] = 'sub/b.md'; plainEdits(value); return value; }, /needs indexed frontmatter attributes/],
    [(value) => { value.updateScenarios.notes[3] = 'a.md'; return value; }, /distinct/],
    [(value) => { value.updateScenarios.bodyEdits['c.md'] = ['## Part', '## Part two']; return value; }, /must not edit a heading/],
    [(value) => { value.updateScenarios.bodyEdits['d.md'] = ['sentence d one.', 'sentence d one.\nAnother line.']; return value; }, /one line/],
    [(value) => { value.updateScenarios.attributeEdits['e.md'] = ['sentence e one.', 'sentence e two.']; return value; }, /only the frontmatter/],
    [(value) => { value.updateScenarios.bodyEdits['a.md'] = ['title: Synthetic A', 'title: X']; return value; }, /body text, not frontmatter/],
  ];
  for (const [mutate, pattern] of cases) {
    const { root, hash } = await heldoutShaped(mutate);
    try { await assert.rejects(loadDataset(root, hash), pattern); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});

/** Four eligible synthetic notes; only p.md carries the body line under test. */
function protocolCase(bodyBlock, oldText, newText) {
  const notes = ['p.md', 'q.md', 'r.md', 's.md'];
  const contents = new Map(notes.map((notePath) => [notePath,
    `---\ntitle: T ${notePath}\nreviewed: no\n---\n## Part\n${notePath === 'p.md' ? bodyBlock : `plain body ${notePath}.`}\n`]));
  const edits = (pick) => Object.fromEntries(notes.map((notePath) => [notePath, pick(notePath)]));
  const updates = { notes, edits: {
    nonTargetFrontmatter: edits(() => ['reviewed: no', 'reviewed: yes']),
    indexedAttribute: edits((notePath) => [`title: T ${notePath}`, `title: T ${notePath} 2`]),
    body: edits((notePath) => (notePath === 'p.md' ? [oldText, newText] : [`plain body ${notePath}.`, `plain body ${notePath}, edited.`])),
  } };
  return () => validateUpdateProtocol(updates, contents);
}

test('a body edit whose resulting line becomes an ATX heading under the main chunker rule is rejected', () => {
  assert.throws(protocolCase('Sentence one. Sentence two.', 'Sentence one. Sentence two.', '## Injected heading'), /heading/);
  assert.throws(protocolCase('  #status: done here.', 'status: done here.', ' New heading'), /heading/,
    'leading whitespace and # kept from the old line make "  # New heading"');
  assert.throws(protocolCase('## Old heading', '## Old heading', 'Plain text now.'), /heading/, 'an existing heading line stays protected');
});

test('lines the main chunker does not treat as headings remain valid body edits', () => {
  assert.doesNotThrow(protocolCase('Mention #tag here.', 'here.', 'there.'));
  assert.doesNotThrow(protocolCase('Sentence one. Sentence two.', 'Sentence two.', '## Not a heading'),
    'the retained prefix keeps "Sentence one. ## Not a heading" an ordinary line');
  assert.doesNotThrow(protocolCase('Mention here.', 'Mention here.', 'Mention #tag here.'));
  assert.doesNotThrow(protocolCase('Plain words.', 'Plain words.', '####### Not ATX'));
  assert.doesNotThrow(protocolCase('    Plain words.', 'Plain words.', '# code'), 'four-space indentation is not ATX');
  assert.doesNotThrow(protocolCase('```\ncode line\n```', 'code line', '# comment'), 'inside a fence the chunker does not split');
  assert.doesNotThrow(protocolCase('Plain words.\n===', 'Plain words.', 'Other words.'));
  assert.equal(chunkMarkdown('s', '    # code\n####### Not ATX\nSetext words\n===\n```\n# comment\n```\nbody').length, 1,
    'the main chunker splits on none of these lines, including a setext underline');
  assert.equal(chunkMarkdown('s', 'intro\n  # New heading\nbody').length, 2, 'indented ATX within three spaces does split');
});

test('held-out schema uses numeric goldLine, explicit literal edit maps and a mandatory manifest', async () => {
  const { root, hash } = await heldoutShaped();
  try {
    const dataset = await loadDataset(root, hash);
    assert.deepEqual(dataset.notes.map((note) => note.path), ['a.md', 'c.md', 'd.md', 'e.md', 'sub/b.md']);
    assert.deepEqual(dataset.questions.map((question) => [question.goldLine, question.resolution, question.sectionLine]),
      [[8, 'goldLine', 7], [2, 'goldLine', 1]]);
    assert.deepEqual(dataset.updates.edits.body['a.md'], ['line one', 'line one changed']);
    assert.deepEqual(dataset.updates.notes, ['a.md', 'c.md', 'd.md', 'e.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const unsealed = await heldoutShaped(undefined, { manifest: false });
  try { await assert.rejects(loadDataset(unsealed.root, unsealed.hash), /manifest.json is missing/); }
  finally { await rm(unsealed.root, { recursive: true, force: true }); }
});

test('held-out inputs with a missing literal, a goldLine outside the note or a stale manifest are rejected', async () => {
  const cases = [
    [(value) => { value.updateScenarios.bodyEdits['a.md'][0] = 'absent text'; return value; }, /absent/],
    [(value) => { value.questions[0].goldLine = 99; return value; }, /goldLine outside/],
    [(value) => { value.questions[1].path = '../escape.md'; return value; }, /unknown note/],
  ];
  for (const [mutate, pattern] of cases) {
    const { root, hash } = await heldoutShaped(mutate);
    try { await assert.rejects(loadDataset(root, hash), pattern); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
  const { root, hash } = await heldoutShaped();
  try {
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ files: { 'questions.json': sha256('other') } }));
    await assert.rejects(loadDataset(root, hash), /manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a note edited after the freeze no longer binds to the snapshot', async () => {
  const { root, hash, notes: original } = await heldoutShaped();
  const copy = await temporary();
  try {
    const { file, snapshot, sha } = await frozen(root, hash);
    await rm(path.dirname(file), { recursive: true, force: true });
    await cp(root, copy, { recursive: true });
    const notePath = path.join(copy, 'corpus', 'a.md');
    const edited = (await readFile(notePath, 'utf8')).replace('line two', 'line 2');
    await writeFile(notePath, edited);
    const manifestPath = path.join(copy, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files['corpus/a.md'] = sha256(edited);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const notes = original.map((note) => (note.path === 'a.md' ? { path: 'a.md', content: edited } : note));
    const parsed = JSON.parse(await readFile(path.join(copy, 'questions.json'), 'utf8'));
    const dataset = await loadDataset(copy, combinedLoaderHash(notes, parsed.questions, parsed.updateScenarios));
    assert.throws(() => bindDataset({ ...snapshot, sha256: sha }, dataset, chunkMarkdown), /file hashes/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(copy, { recursive: true, force: true });
  }
});
