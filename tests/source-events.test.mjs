import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

async function bundle(relativePath, format = 'esm') {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true,
    platform: 'node',
    format,
    external: ['obsidian'],
    write: false,
  });
  return outputFiles[0];
}

const registryBundle = await bundle('../src/core/index/source-registry.ts');
const { SourceRegistry } = await import(`data:text/javascript;base64,${Buffer.from(registryBundle.contents).toString('base64')}`);

class TFile {
  constructor(path, content) {
    this.path = path;
    this.extension = path.split('.').at(-1);
    this.content = content;
    this.stat = { mtime: 20, size: content.length };
  }
}

const sourceEventsBundle = await bundle('../src/obsidian/source-events.ts', 'cjs');
const module = { exports: {} };
runInNewContext(sourceEventsBundle.text, {
  module,
  exports: module.exports,
  require: () => ({ TFile }),
  crypto: webcrypto,
  TextEncoder,
});
const { SourceEventHandler } = module.exports;

function makeRegistry() {
  let saved;
  return SourceRegistry.open({
    load: async () => saved,
    save: async (records) => { saved = structuredClone(records); },
  });
}

test('Markdown create event stores source metadata and ignores duplicate events', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const note = new TFile('Notes/new.md', '# New');
  await Promise.all([handler.create(note), handler.create(note)]);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.getByPath(note.path).mtime, 20);
  assert.equal(registry.getByPath(note.path).size, 5);
  assert.match(registry.getByPath(note.path).content_hash, /^[a-f0-9]{64}$/);
});

test('non-Markdown and folder create events do not read or register sources', async () => {
  const registry = await makeRegistry();
  let reads = 0;
  const handler = new SourceEventHandler({ read: async () => { reads += 1; return ''; } }, registry);
  await handler.create(new TFile('photo.png', 'binary'));
  await handler.create({ path: 'Folder' });
  assert.equal(reads, 0);
  assert.deepEqual(registry.list(), []);
});

test('failed Vault read leaves registry unchanged and does not block later events', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({
    read: async (file) => {
      if (file.path === 'bad.md') throw new Error('read failed');
      return file.content;
    },
  }, registry);
  await assert.rejects(handler.create(new TFile('bad.md', 'x')), /read failed/);
  await handler.create(new TFile('good.md', '# Good'));
  assert.equal(registry.list().length, 1);
});

test('Markdown modify detects changed content and updates source metadata', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const file = new TFile('note.md', '# Before');
  await handler.create(file);
  const original = registry.getByPath(file.path);
  file.content = '# After';
  file.stat = { mtime: 21, size: file.content.length };
  const result = await handler.modify(file);
  assert.deepEqual(structuredClone(result), { sourceId: original.source_id, contentChanged: true });
  assert.notEqual(registry.getByPath(file.path).content_hash, original.content_hash);
  assert.equal(registry.getByPath(file.path).mtime, 21);

  const repeated = await handler.modify(file);
  assert.deepEqual(structuredClone(repeated), { sourceId: original.source_id, contentChanged: false });
  file.stat.mtime = 22;
  assert.equal((await handler.modify(file)).contentChanged, false);
  assert.equal(registry.getByPath(file.path).mtime, 22);
});

test('modify ignores non-Markdown and unknown sources', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async () => { throw new Error('unexpected read'); } }, registry);
  assert.equal(await handler.modify(new TFile('photo.png', 'binary')), undefined);
  assert.equal(await handler.modify(new TFile('unknown.md', '# Unknown')), undefined);
});

test('renaming a Markdown file preserves its source ID and updates the path', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const file = new TFile('Notes/original.md', '# Note');
  await handler.create(file);
  const sourceId = registry.getByPath(file.path).source_id;
  file.path = 'Moved/renamed.md';
  file.extension = 'md';
  assert.deepEqual(structuredClone(await handler.rename(file, 'Notes/original.md')), [sourceId]);
  assert.equal(registry.getByPath('Notes/original.md'), undefined);
  assert.equal(registry.getByPath(file.path).source_id, sourceId);
  assert.deepEqual(structuredClone(await handler.rename(file, 'Notes/original.md')), []);
});

test('renaming a folder moves all contained Markdown paths without changing IDs', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  await handler.create(new TFile('Old/one.md', 'One'));
  await handler.create(new TFile('Old/Nested/two.md', 'Two'));
  const originalIds = registry.list().map((record) => record.source_id);
  const movedIds = await handler.rename({ path: 'New' }, 'Old');
  assert.deepEqual(structuredClone(movedIds), originalIds);
  assert.deepEqual(registry.list().map((record) => record.path), ['New/one.md', 'New/Nested/two.md']);
});

test('extension changes add or remove Markdown sources', async () => {
  const registry = await makeRegistry();
  const handler = new SourceEventHandler({ read: async (file) => file.content }, registry);
  const file = new TFile('draft.txt', '# Draft');
  file.path = 'draft.md';
  file.extension = 'md';
  const [sourceId] = await handler.rename(file, 'draft.txt');
  assert.equal(registry.getByPath('draft.md').source_id, sourceId);
  file.path = 'draft.txt';
  file.extension = 'txt';
  assert.deepEqual(structuredClone(await handler.rename(file, 'draft.md')), [sourceId]);
  assert.equal(registry.getById(sourceId), undefined);
});
