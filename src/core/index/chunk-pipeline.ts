import { chunkMarkdown } from './markdown-chunker';
import type { ChunkRegistry } from './chunk-registry';
import type { SourceRegistry } from './source-registry';

export class ChunkPipeline {
  constructor(
    private readonly sources: Pick<SourceRegistry, 'getById'>,
    private readonly chunks: Pick<ChunkRegistry, 'replaceBySource' | 'deleteBySource' | 'clear'>,
  ) {}

  async sync(sourceId: string, markdown: string): Promise<void> {
    if (!this.sources.getById(sourceId)) throw new Error('Source is not registered.');
    const next = chunkMarkdown(sourceId, markdown);
    await this.chunks.replaceBySource(sourceId, next);
  }

  async delete(sourceId: string): Promise<void> {
    await this.chunks.deleteBySource(sourceId);
  }

  async clear(): Promise<void> {
    await this.chunks.clear();
  }
}
