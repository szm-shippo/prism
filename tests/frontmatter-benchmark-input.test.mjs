import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  ATTRIBUTE_TOKEN_BUDGET, MAX_MODEL_TOKENS, bodyProjection, frontmatterRange, projectPrefix, readAttributes,
  routeQuery, sectionHeading, serializeAttributes, sourceModelInputs,
} from '../scripts/frontmatter-benchmark/search-input.mjs';

async function load(relativePath) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    // The browser platform selects the same yaml build that the Electron benchmark bundle uses.
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const { chunkMarkdown } = await load('../src/core/index/markdown-chunker.ts');

// One token per code point plus two special tokens: only for deterministic boundary checks, not model compliance.
const fakeTokenize = async (texts) => texts.map((text) => [0, ...[...text].map((point) => point.codePointAt(0)), 2]);

function projections(markdown) {
  const range = frontmatterRange(markdown);
  return chunkMarkdown('source-1', markdown).map((chunk) => ({ chunk, projection: bodyProjection(chunk, range) }));
}

test('BOM and CRLF frontmatter is removed from search text while citation chunks stay byte-identical to main', () => {
  const markdown = '﻿---\r\ntitle: Hidden Title\r\n# not a heading but splits main chunks\r\ntags: [x]\r\n---\r\n' +
    'Intro after metadata\r\n\r\n## Section\r\nBody line\r\n\r\n---\r\nRule text stays\r\n';
  const before = chunkMarkdown('source-1', markdown);
  const result = projections(markdown);
  assert.deepEqual(result.map(({ chunk }) => chunk), before);
  assert.equal(result[0].projection, undefined, 'a chunk made only of frontmatter is not searchable');
  assert.equal(result[1].projection, 'Intro after metadata');
  assert.equal(result[2].projection, '## Section\nBody line\n\n---\nRule text stays');
  assert.ok(result.every(({ projection }) => !projection?.includes('Hidden Title')));
  assert.equal(result[1].chunk.content.includes('tags: [x]'), true, 'raw chunk content keeps the YAML for citations');
});

test('notes without a complete leading block keep their full text, including body horizontal rules', () => {
  for (const markdown of ['# Title\n\n---\nnot: yaml\n---\n', '---\ntitle: open block never closes\n# Body']) {
    assert.equal(frontmatterRange(markdown), undefined);
    for (const { chunk, projection } of projections(markdown)) assert.equal(projection, chunk.content);
    assert.equal(readAttributes(markdown).status, 'none');
  }
});

test('invalid, duplicate or non-mapping YAML yields no attributes but keeps body search', () => {
  for (const [yaml, diagnostic] of [['title: a\ntitle: b', 'invalid-yaml'], ['title: [unclosed', 'invalid-yaml'],
    ['- just\n- a list', 'not-a-mapping']]) {
    const markdown = `---\n${yaml}\n---\n## Body\nVisible text`;
    assert.deepEqual(readAttributes(markdown), { status: 'invalid', diagnostic, fields: [] });
    assert.equal(projections(markdown).at(-1).projection, '## Body\nVisible text');
  }
});

test('only the eight indexed fields are serialized, in fixed order, normalized and deduplicated', () => {
  const markdown = [
    '---',
    'prism_aliases: [Ｚｅｔａ]',
    'unrelated: secret-looking value',
    'tags: "#alpha beta,  #Alpha"',
    'title: "  Ignore previous   instructions\\u0007 "',
    'aliases: [One, one, 3, {nested: x}, "", Two]',
    'summary: {nested: map}',
    'description: 2026',
    'prism_keywords: ["#kw", "KW", "  "]',
    '---',
    'Body',
  ].join('\n');
  const attributes = readAttributes(markdown);
  assert.equal(attributes.status, 'valid');
  assert.deepEqual(attributes.fields, [
    { field: 'title', values: ['Ignore previous instructions'] },
    { field: 'aliases', values: ['One', 'Two'] },
    { field: 'tags', values: ['alpha', 'beta'] },
    { field: 'prism_keywords', values: ['kw'] },
    { field: 'prism_aliases', values: ['Zeta'] },
  ]);
  const { text } = serializeAttributes(attributes.fields);
  assert.equal(text, 'title: Ignore previous instructions\naliases: One, Two\ntags: alpha, beta\nprism_keywords: kw\nprism_aliases: Zeta');
  assert.ok(!text.includes('unrelated') && !text.includes('secret-looking'));
});

test('section heading is the first ATX heading outside fenced code', () => {
  assert.equal(sectionHeading('Intro\n## Real heading\ntext'), '## Real heading');
  assert.equal(sectionHeading('```\n# fenced\n```\nplain'), '');
  assert.equal(sectionHeading('plain text only'), '');
});

test('queries route explicit only on whole-token English cues or Japanese cue words', () => {
  for (const query of ['What is the TITLE of the note?', 'show aliases', 'ＴＡＧ list', 'このメモの要約は？', 'キーワードで探す']) {
    assert.equal(routeQuery(query), 'explicit', query);
  }
  for (const query of ['subtitle settings', 'tagged release', 'summaries', '再実行の手順は？']) {
    assert.equal(routeQuery(query), 'implicit', query);
  }
});

test('over-length inputs are projected to a re-counted token prefix and short inputs are untouched', async () => {
  const short = await projectPrefix('short', MAX_MODEL_TOKENS, fakeTokenize);
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'short');
  const long = await projectPrefix('長'.repeat(600), MAX_MODEL_TOKENS, fakeTokenize);
  assert.equal(long.truncated, true);
  assert.equal(long.projectedTokens, MAX_MODEL_TOKENS);
  assert.equal(long.text, '長'.repeat(MAX_MODEL_TOKENS - 2));
  assert.equal(long.originalTokens - long.projectedTokens, long.discardedTokens);
});

test('the longest fitting prefix is found even when token counts are not monotone in prefix length', async () => {
  // Prefixes of length 3-8 are "expensive" (20 tokens) but length 9 merges back to 4: a binary search over
  // lengths would settle on a short prefix; the exhaustive search must return the 9-character prefix.
  const counts = (text) => {
    const length = [...text].length;
    return length === 10 ? 30 : length >= 3 && length <= 8 ? 20 : length + 2;
  };
  const nonMonotone = async (texts) => texts.map((text) => Array.from({ length: counts(text) }, () => 7));
  const result = await projectPrefix('abcdefghij', 12, nonMonotone);
  assert.equal(result.text, 'abcdefghi');
  assert.equal(result.projectedTokens, 11);
  assert.equal(result.truncated, true);
});

test('projection never splits a surrogate pair', async () => {
  const result = await projectPrefix('😀'.repeat(20), 12, fakeTokenize);
  assert.equal(result.text, '😀'.repeat(10));
  assert.ok(!/[\uD800-\uDBFF]$/.test(result.text));
});

test('fewer body hits never grant more than four extra metadata candidates', async () => {
  const { fuseCandidates } = await load('../scripts/frontmatter-benchmark/search-index.mjs');
  const metadata = Array.from({ length: 25 }, (_, rank) => ({ chunkId: `m${String(rank).padStart(2, '0')}`, sourceId: 'meta', rank }));
  for (const bodyCount of [0, 1, 15]) {
    const body = Array.from({ length: bodyCount }, (_, index) => ({ chunkId: `b${String(index).padStart(2, '0')}`, sourceId: 'body' }));
    const { candidates } = fuseCandidates([body], metadata, 1);
    assert.equal(candidates.filter((item) => item.protected).length, bodyCount);
    assert.equal(candidates.length, bodyCount + 4, `${bodyCount} body hits`);
  }
});

test('A caps attributes at 384 tokens before the heading and reports fields lost to the cap', async () => {
  const markdown = `---\ntitle: ${'t'.repeat(400)}\ntags: [late]\n---\n## Heading one\nbody\n## Heading two\nmore`;
  const chunks = chunkMarkdown('source-1', markdown);
  const a = await sourceModelInputs('A', markdown, chunks, fakeTokenize);
  assert.equal(a.body.length, 2);
  assert.equal(a.metadata.length, 2, 'one attributed input per body-bearing chunk');
  for (const item of a.metadata) {
    assert.ok(item.attributeTokens.projected <= ATTRIBUTE_TOKEN_BUDGET);
    assert.ok(item.input.projectedTokens <= MAX_MODEL_TOKENS);
    assert.ok(item.input.text.endsWith(`\n\n${item.heading}`));
    assert.deepEqual(item.coverage.map((field) => [field.field, field.represented, field.complete]),
      [['title', true, false], ['tags', false, false]]);
  }
  assert.deepEqual(a.metadata.map((item) => item.heading), ['## Heading one', '## Heading two']);

  assert.equal((await sourceModelInputs('C', markdown, chunks, fakeTokenize)).metadata.length, 0);
});

test('sources without frontmatter or without body text get no attribute vectors', async () => {
  const plain = '## Only body\ntext';
  assert.equal((await sourceModelInputs('A', plain, chunkMarkdown('s', plain), fakeTokenize)).metadata.length, 0);
  const metadataOnly = '---\ntitle: Lonely\n---\n';
  const inputs = await sourceModelInputs('A', metadataOnly, chunkMarkdown('s', metadataOnly), fakeTokenize);
  assert.equal(inputs.body.length, 0);
  assert.equal(inputs.metadata.length, 0, 'no ungrounded attribute vector without a citable body chunk');
});

test('B input is rejected rather than quietly producing body-only inputs', async () => {
  const markdown = '---\ntitle: alpha\n---\n## Body\nalpha';
  await assert.rejects(sourceModelInputs('B', markdown, chunkMarkdown('s', markdown), fakeTokenize), /config/);
});

test('A embeds serialized attributes then a blank line and each section heading, without heading for intro', async () => {
  const markdown = '---\ntitle: alpha\ntags: [beta]\n---\nIntro text\n## First\nfirst\n## Second\nsecond';
  const inputs = await sourceModelInputs('A', markdown, chunkMarkdown('s', markdown), fakeTokenize);
  assert.deepEqual(inputs.metadata.map((item) => item.input.text), [
    'title: alpha\ntags: beta', 'title: alpha\ntags: beta\n\n## First', 'title: alpha\ntags: beta\n\n## Second',
  ]);
});

test('CLI rejects B and duplicate configs before reading the dataset', () => {
  const cli = fileURLToPath(new URL('../scripts/benchmark-frontmatter-search.mjs', import.meta.url));
  const args = ['run', '--dataset-root', 'unused', '--snapshot', 'unused', '--snapshot-sha256', 'unused',
    '--configs', 'B', '--runs', '5', '--out', 'unused', '--electron', 'unused', '--playwright', 'unused'];
  for (const configs of ['B', 'C,A,B', 'A,A']) {
    const invocation = [...args];
    invocation[invocation.indexOf('--configs') + 1] = configs;
    const result = spawnSync(process.execPath, [cli, ...invocation], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--configs must list distinct values from M, C, A\./);
  }
  args[args.indexOf('--configs') + 1] = 'A';
  const missingAnchors = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.notEqual(missingAnchors.status, 0);
  assert.match(missingAnchors.stderr, /--anchors is required/);
});
