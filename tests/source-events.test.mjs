import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
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
