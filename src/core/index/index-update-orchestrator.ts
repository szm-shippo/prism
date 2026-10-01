import type { ChunkRegistry } from './chunk-registry';
import type { FullTextSearch } from './full-text-search';
import { validateVectorDimensions, type VectorEntry, type VectorStore } from './vector-store';
import type { EmbeddingProvider } from '../provider/embedding-provider';

type IndexVectors = Pick<VectorStore, 'dimensions' | 'put' | 'delete' | 'deleteBySource' | 'listBySource'>;

export class IndexUpdateOrchestrator {
  constructor(
    private readonly chunks: Pick<ChunkRegistry, 'listBySource'>,
    private readonly fullText: Pick<FullTextSearch, 'index' | 'deleteBySource'>,
    private readonly embeddings: Pick<EmbeddingProvider, 'embedBatch'>,
    private readonly vectorStore: (dimensions?: number) => Promise<IndexVectors | undefined>,
  ) {}

  async sync(sourceId: string): Promise<void> {
    const chunks = this.chunks.listBySource(sourceId);
    await this.fullText.deleteBySource(sourceId);
    if (chunks.length > 0) await this.fullText.index(chunks);
    const existingStore = await this.vectorStore();
    const stored = existingStore?.listBySource(sourceId) ?? [];
    const current = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk.content_hash]));
    const changed = chunks.filter((chunk) => !stored.some((entry) =>
      entry.chunkId === chunk.chunk_id && entry.contentHash === chunk.content_hash));
    for (const entry of stored) {
      if (!current.has(entry.chunkId) || current.get(entry.chunkId) !== entry.contentHash) {
        await existingStore?.delete(entry.chunkId);
      }
    }
    if (changed.length === 0) return;
    const vectors = await this.embeddings.embedBatch(changed.map((chunk) => chunk.content));
    if (vectors.length !== changed.length || vectors[0]?.length === 0) {
      throw new Error('Embedding provider returned the wrong number of vectors.');
    }
    const dimensions = vectors[0].length;
    const entries: VectorEntry[] = changed.map((chunk, index) => {
      validateVectorDimensions(vectors[index], dimensions);
      let magnitude = 0;
      for (const value of vectors[index]) magnitude = Math.hypot(magnitude, value);
      if (!Number.isFinite(magnitude) || magnitude === 0) {
        throw new Error('Embedding provider returned an invalid or zero vector.');
      }
      return { chunkId: chunk.chunk_id, sourceId, values: vectors[index], contentHash: chunk.content_hash };
    });
    const vectorStore = await this.vectorStore(dimensions);
    if (!vectorStore) throw new Error('Vector store is unavailable.');
    await vectorStore.put(entries);
  }

  async delete(sourceId: string): Promise<void> {
    const vectorStore = await this.vectorStore();
    await this.fullText.deleteBySource(sourceId);
    await vectorStore?.deleteBySource(sourceId);
  }
}
