import type { ChunkRegistry } from './chunk-registry';
import type { FullTextSearch } from './full-text-search';
import { validateVectorDimensions, type VectorEntry, type VectorStore } from './vector-store';
import type { EmbeddingProvider } from '../provider/embedding-provider';

type IndexVectors = Pick<VectorStore, 'dimensions' | 'put' | 'deleteBySource'>;

export class IndexUpdateOrchestrator {
  constructor(
    private readonly chunks: Pick<ChunkRegistry, 'listBySource'>,
    private readonly fullText: Pick<FullTextSearch, 'index' | 'deleteBySource'>,
    private readonly embeddings: Pick<EmbeddingProvider, 'embedBatch'>,
    private readonly vectorStore: (dimensions?: number) => Promise<IndexVectors | undefined>,
  ) {}

  async sync(sourceId: string): Promise<void> {
    const chunks = this.chunks.listBySource(sourceId);
    let entries: VectorEntry[] = [];
    let dimensions: number | undefined;
    if (chunks.length > 0) {
      const vectors = await this.embeddings.embedBatch(chunks.map((chunk) => chunk.content));
      if (vectors.length !== chunks.length || vectors[0]?.length === 0) {
        throw new Error('Embedding provider returned the wrong number of vectors.');
      }
      dimensions = vectors[0].length;
      entries = chunks.map((chunk, index) => {
        validateVectorDimensions(vectors[index], dimensions!);
        let magnitude = 0;
        for (const value of vectors[index]) magnitude = Math.hypot(magnitude, value);
        if (!Number.isFinite(magnitude) || magnitude === 0) {
          throw new Error('Embedding provider returned an invalid or zero vector.');
        }
        return { chunkId: chunk.chunk_id, sourceId, values: vectors[index] };
      });
    }
    const vectorStore = await this.vectorStore(dimensions);
    if (chunks.length > 0 && !vectorStore) throw new Error('Vector store is unavailable.');
    await this.fullText.deleteBySource(sourceId);
    if (chunks.length > 0) await this.fullText.index(chunks);
    if (vectorStore) {
      await vectorStore.deleteBySource(sourceId);
      if (entries.length > 0) await vectorStore.put(entries);
    }
  }

  async delete(sourceId: string): Promise<void> {
    const vectorStore = await this.vectorStore();
    await this.fullText.deleteBySource(sourceId);
    await vectorStore?.deleteBySource(sourceId);
  }
}
