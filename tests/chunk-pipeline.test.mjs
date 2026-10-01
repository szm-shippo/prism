import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(relativePath) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const { ChunkPipeline } = await load('../src/core/index/chunk-pipeline.ts');
const { ChunkRegistry } = await load('../src/core/index/chunk-registry.ts');
const { SourceRegistry } = await load('../src/core/index/source-registry.ts');

test('pipeline chunks a registered source and deletes only its chunks', async () => {
  let sourcesSaved;
  let chunksSaved;
  const sources = await SourceRegistry.open({
    load: async () => sourcesSaved,
    save: async (records) => { sourcesSaved = structuredClone(records); },
  });
  const first = await sources.create({ path: 'first.md', content: '# First', mtime: 1, size: 7 });
  const second = await sources.create({ path: 'second.md', content: '# Second', mtime: 1, size: 8 });
  const chunks = await ChunkRegistry.open({
    load: async () => chunksSaved,
    save: async (records) => { chunksSaved = structuredClone(records); },
  }, sources);
  const pipeline = new ChunkPipeline(sources, chunks);
  await pipeline.sync(first.source_id, '# First\n## Detail');
  await pipeline.sync(second.source_id, '# Second');
  assert.equal(chunks.listBySource(first.source_id).length, 2);
  await pipeline.sync(first.source_id, '# Revised');
  assert.equal(chunks.listBySource(first.source_id).length, 1);
  assert.equal(chunks.listBySource(second.source_id).length, 1);
  await pipeline.delete(first.source_id);
  assert.deepEqual(chunks.listBySource(first.source_id), []);
  assert.equal(chunks.listBySource(second.source_id).length, 1);
  assert.equal((await ChunkRegistry.open({ load: async () => chunksSaved }, sources)).listBySource(first.source_id).length, 0);
});
