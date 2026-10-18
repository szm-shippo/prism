import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parse } from 'yaml';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/frontmatter-update.ts', import.meta.url))],
  // The browser platform selects the same yaml build that main.js bundles.
  bundle: true, platform: 'browser', format: 'esm', write: false,
});
const { parseNote } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

const generated = {
  prism_summary: 'Alpha release plan',
  prism_keywords: ['alpha', 'release'],
  prism_aliases: ['α'],
};
const generatedYaml = 'prism_summary: "Alpha release plan"\nprism_keywords: ["alpha", "release"]\nprism_aliases: ["α"]\n';

function applyEdit(content, { from, to, text }) {
  return content.slice(0, from) + text + content.slice(to);
}

function rejects(content, reason) {
  assert.throws(() => parseNote(content), (error) => {
    assert.equal(error.name, 'FrontmatterError', JSON.stringify(content));
    assert.equal(error.reason, reason, JSON.stringify(content));
    return true;
  });
}

test('a note without frontmatter gains a block with only the three Prism fields and keeps every body byte', () => {
  const content = '# Alpha\n\nBody with key: value and a horizontal rule below.\n\n---\n\nEnd\n';
  const note = parseNote(content);
  assert.equal(note.body, content);
  const update = note.update(generated);
  assert.equal(update.content, `---\n${generatedYaml}---\n${content}`);
  assert.equal(applyEdit(content, update), update.content);
  assert.deepEqual([update.from, update.to], [0, 0]);
});

test('comments, blank lines, quoting and nested values outside the Prism values are kept byte for byte', () => {
  const before = [
    '# Project metadata',
    'title: "Project: Alpha" # keep this comment',
    '',
    'tags:',
    '  - project   # inline note',
    '  - 2024',
    '"prism_summary": |',
    '  Old summary',
    '  spanning lines',
    '',
    '# Plugin settings below',
    'plugin_data:',
    '  nested: {count: 3}',
    '  notes: >-',
    '    folded',
    '    text',
    "'prism_keywords':",
    '  - old',
    '  - stale',
    'prism_aliases: [old] # aliases comment',
    'status: draft',
    '',
  ].join('\n');
  const after = [
    '# Project metadata',
    'title: "Project: Alpha" # keep this comment',
    '',
    'tags:',
    '  - project   # inline note',
    '  - 2024',
    '"prism_summary": "Alpha release plan"',
    '',
    '# Plugin settings below',
    'plugin_data:',
    '  nested: {count: 3}',
    '  notes: >-',
    '    folded',
    '    text',
    "'prism_keywords': []",
    'prism_aliases: ["α"] # aliases comment',
    'status: draft',
    '',
  ].join('\n');
  const body = '# Alpha\n\nBody text\n\n---\ntitle: not frontmatter\n---\n';
  const content = `---\n${before}---\n${body}`;
  const note = parseNote(content);
  assert.equal(note.body, body);
  const update = note.update({ ...generated, prism_keywords: [] });
  assert.equal(update.content, `---\n${after}---\n${body}`);
  assert.equal(applyEdit(content, update), update.content);
  // The editor change starts at the first Prism value and ends with the last one.
  assert.equal(update.from, content.indexOf('"prism_summary":') + '"prism_summary":'.length);
  assert.equal(update.to, content.indexOf('[old]') + '[old]'.length);
  assert.deepEqual(parse(after), {
    title: 'Project: Alpha', tags: ['project', 2024], prism_summary: 'Alpha release plan',
    plugin_data: { nested: { count: 3 }, notes: 'folded text' }, prism_keywords: [], prism_aliases: ['α'],
    status: 'draft',
  });
});

test('empty Prism values and explicit keys are filled in place and their trailing comments stay', () => {
  const before = 'prism_summary:\nprism_keywords: # filled by Prism\n? prism_aliases\n: []\n';
  const after = 'prism_summary: "Alpha release plan"\nprism_keywords: ["alpha", "release"] # filled by Prism\n' +
    '? prism_aliases\n: ["α"]\n';
  assert.equal(parseNote(`---\n${before}---\nBody\n`).update(generated).content, `---\n${after}---\nBody\n`);
});

test('missing Prism fields are appended after the existing YAML and its trailing comments, keeping BOM and CRLF', () => {
  const crlf = (text) => text.replaceAll('\n', '\r\n');
  const body = crlf('Line one\n---\nLine two\n');
  const existing = crlf('title: Windows\n# trailing comment\n');
  const note = parseNote(`﻿${crlf('---\n')}${existing}${crlf('---\n')}${body}`);
  assert.equal(note.body, body);
  assert.equal(note.update(generated).content, `﻿${crlf('---\n')}${existing}${crlf(`${generatedYaml}---\n`)}${body}`);

  const fresh = parseNote(`﻿${body}`);
  assert.equal(fresh.body, body);
  const update = fresh.update(generated);
  assert.equal(update.content, `﻿${crlf(`---\n${generatedYaml}---\n`)}${body}`);
  assert.deepEqual([update.from, update.to], [1, 1]);
});

test('comment-only or blank frontmatter is an empty mapping and gains the Prism fields after its comments', () => {
  for (const yaml of ['', '\n', '# Only a comment\n\n', '   \n# Another comment\n']) {
    const note = parseNote(`---\n${yaml}---\nBody\n`);
    assert.equal(note.body, 'Body\n');
    assert.equal(note.update(generated).content, `---\n${yaml}${generatedYaml}---\nBody\n`);
  }
});

test('frontmatter-only notes have an empty body, including a closing delimiter at the end of the file', () => {
  assert.equal(parseNote('---\ntitle: Only\n---\n').body, '');
  const note = parseNote('---\ntitle: Only\n---');
  assert.equal(note.body, '');
  assert.equal(note.update(generated).content, `---\ntitle: Only\n${generatedYaml}---`);
});

test('only the leading frontmatter is parsed and YAML-like body text is never touched', () => {
  const body = 'Body\n---\nprism_summary: fake\n---\n```yaml\nprism_keywords: [fake]\n```\n';
  const note = parseNote(`---\ntitle: Real\n---\n${body}`);
  assert.equal(note.body, body);
  assert.equal(note.update(generated).content, `---\ntitle: Real\n${generatedYaml}---\n${body}`);
});

test('generated strings that look like YAML stay quoted values and cannot add keys or delimiters', () => {
  const hostile = {
    prism_summary: '--- title: hacked # not a comment: [x] {y} &a *b !tag | > % @ `',
    prism_keywords: ['- item', 'key: value', 'true', '123', 'null', '2024-01-01', "it's", '"quoted"', '...', 'back\\slash'],
    prism_aliases: ['---', '#tag', '[alias]', '﻿bom'],
  };
  const update = parseNote('---\ntitle: Safe\n---\nBody\n').update(hostile);
  const [, yaml, body] = /^---\n([\s\S]*?)^---\n([\s\S]*)$/m.exec(update.content);
  assert.deepEqual(parse(yaml), { title: 'Safe', ...hostile });
  assert.equal(body, 'Body\n');
  assert.equal(update.content.match(/^---$/gm).length, 2);
});

test('duplicate keys are rejected before anything is sent, including quoted and nested duplicates', () => {
  for (const yaml of [
    'title: one\ntitle: two\n',
    'title: one\n"title": two\n',
    'prism_summary: a\nprism_summary: b\n',
    "'1': a\n1: b\n",
    'plugin:\n  key: 1\n  key: 2\n',
  ]) rejects(`---\n${yaml}---\nBody\n`, 'invalid_yaml');
});

test('invalid YAML, multiple documents and non-mapping roots are rejected before anything is sent', () => {
  for (const yaml of ['title: [unclosed\n', 'title: x\n--- \nother: y\n', '- just\n- a list\n', 'just text\n',
    'a: b\n\tc: d\n']) {
    rejects(`---\n${yaml}---\nBody\n`, 'invalid_yaml');
  }
});

test('syntax this updater cannot edit exactly is rejected before anything is sent', () => {
  for (const yaml of [
    '{title: Flow, prism_summary: old}\n',
    '  title: indented root\n',
    '%YAML 1.2\n--- \ntitle: x\n',
    'title: x\n...\n',
    'title: !!str tagged\n',
    'title: !custom tagged\n',
    'base: &shared text\nother: *shared\n',
    'prism_summary: &summary Shared\ntitle: *summary\n',
    'links: [*missing]\n',
    '<<: {inherited: 1}\nown: 2\n',
    'nested: {<<: {inherited: 1}}\n',
    'prism_keywords:\n  - old # reason\n  - stale\n',
    'prism_keywords: # list\n  - old\n',
    'prism_summary: | # header comment\n  text\n',
    '? prism_summary\n',
  ]) rejects(`---\n${yaml}---\nBody\n`, 'unsupported');
  for (const content of ['---\ntitle: Unterminated\nBody\n', '--- \ntitle: x\n---\nBody\n', '----\nBody\n',
    '---title\nBody\n', '---']) {
    rejects(content, 'unsupported');
  }
});

test('an update whose written YAML would not read back as the requested values is refused', () => {
  const note = parseNote('---\ntitle: Safe\n---\nBody\n');
  assert.throws(() => note.update({ ...generated, prism_aliases: [Number.NaN] }),
    (error) => error.name === 'FrontmatterError' && error.reason === 'unsupported');
});
