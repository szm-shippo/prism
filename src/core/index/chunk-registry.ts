import type { MarkdownChunk } from './markdown-chunker';
import type { SourceRegistry } from './source-registry';

export interface ChunkRegistryStorage {
  load(): Promise<unknown>;
  save(chunks: readonly MarkdownChunk[]): Promise<void>;
}

function validChunk(value: unknown): value is MarkdownChunk {
  if (typeof value !== 'object' || value === null) return false;
  const chunk = value as Record<string, unknown>;
  if (typeof chunk.location !== 'object' || chunk.location === null) return false;
  const location = chunk.location as Record<string, unknown>;
  return typeof chunk.chunk_id === 'string' && chunk.chunk_id.length > 0 &&
    typeof chunk.source_id === 'string' && chunk.source_id.length > 0 &&
    typeof chunk.content === 'string' &&
    typeof chunk.content_hash === 'string' && chunk.content_hash.length > 0 &&
    typeof location.startLine === 'number' && Number.isSafeInteger(location.startLine) && location.startLine > 0 &&
    typeof location.endLine === 'number' && Number.isSafeInteger(location.endLine) &&
    location.endLine >= location.startLine;
}

function copy(chunk: MarkdownChunk): MarkdownChunk {
  return { ...chunk, location: { ...chunk.location } };
}

export class ChunkRegistry {
  private constructor(
    private readonly storage: ChunkRegistryStorage,
    private readonly sources: Pick<SourceRegistry, 'getById'>,
    private chunks: MarkdownChunk[],
  ) {}

  static async open(
    storage: ChunkRegistryStorage,
    sources: Pick<SourceRegistry, 'getById'>,
  ): Promise<ChunkRegistry> {
    const loaded = await storage.load();
    if (loaded === undefined || loaded === null) return new ChunkRegistry(storage, sources, []);
    if (!Array.isArray(loaded) || !loaded.every(validChunk) ||
        new Set(loaded.map((chunk) => chunk.chunk_id)).size !== loaded.length) {
      throw new Error('Chunk Registry data is invalid; rebuild it from Vault Markdown.');
    }
    return new ChunkRegistry(storage, sources, loaded.map(copy));
  }

  get(chunkId: string): MarkdownChunk | undefined {
    const chunk = this.chunks.find((item) => item.chunk_id === chunkId);
    return chunk && copy(chunk);
  }

  listBySource(sourceId: string): MarkdownChunk[] {
    return this.chunks.filter((chunk) => chunk.source_id === sourceId).map(copy);
  }

  async put(chunks: readonly MarkdownChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    if (!chunks.every(validChunk) ||
        new Set(chunks.map((chunk) => chunk.chunk_id)).size !== chunks.length ||
        chunks.some((chunk) => !this.sources.getById(chunk.source_id))) {
      throw new Error('Valid chunks with registered source IDs are required.');
    }
    const next = this.chunks.map(copy);
    for (const chunk of chunks) {
      const index = next.findIndex((item) => item.chunk_id === chunk.chunk_id);
      if (index >= 0 && next[index].source_id !== chunk.source_id) {
        throw new Error('Chunk ID already belongs to another source.');
      }
      if (index >= 0) next[index] = copy(chunk);
      else next.push(copy(chunk));
    }
    await this.commit(next);
  }

  async deleteBySource(sourceId: string): Promise<number> {
    const next = this.chunks.filter((chunk) => chunk.source_id !== sourceId);
    const removed = this.chunks.length - next.length;
    if (removed > 0) await this.commit(next);
    return removed;
  }

  provenance(chunkId: string): { sourceId: string; path: string; startLine: number; endLine: number } | undefined {
    const chunk = this.get(chunkId);
    if (!chunk) return undefined;
    const source = this.sources.getById(chunk.source_id);
    if (!source) return undefined;
    return {
      sourceId: chunk.source_id,
      path: source.path,
      startLine: chunk.location.startLine,
      endLine: chunk.location.endLine,
    };
  }

  async replaceBySource(sourceId: string, chunks: readonly MarkdownChunk[]): Promise<void> {
    if (!this.sources.getById(sourceId) ||
        !chunks.every((chunk) => validChunk(chunk) && chunk.source_id === sourceId) ||
        new Set(chunks.map((chunk) => chunk.chunk_id)).size !== chunks.length) {
      throw new Error('Valid chunks for a registered source are required.');
    }
    const retained = this.chunks.filter((chunk) => chunk.source_id !== sourceId);
    if (chunks.some((chunk) => retained.some((item) => item.chunk_id === chunk.chunk_id))) {
      throw new Error('Chunk ID already belongs to another source.');
    }
    const current = this.chunks.filter((chunk) => chunk.source_id === sourceId);
    if (JSON.stringify(current) === JSON.stringify(chunks)) return;
    const next = [...retained.map(copy), ...chunks.map(copy)];
    await this.commit(next);
  }

  private async commit(next: MarkdownChunk[]): Promise<void> {
    await this.storage.save(next);
    this.chunks = next;
  }
}
