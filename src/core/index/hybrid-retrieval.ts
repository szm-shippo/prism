import type { FullTextSearch } from './full-text-search';
import type { VectorStore } from './vector-store';

export interface RetrievalCandidate {
  chunkId: string;
  sourceId: string;
  score: number;
}

export class HybridRetrieval {
  constructor(
    private readonly fullText: Pick<FullTextSearch, 'search'>,
    private readonly vectors: Pick<VectorStore, 'search'>,
  ) {}

  async retrieve(text: string, vector: readonly number[], limit: number): Promise<RetrievalCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('A non-negative retrieval limit is required.');
    }
    if (limit === 0) return [];
    const candidateLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(10, limit * 3));
    const [textHits, vectorHits] = await Promise.all([
      this.fullText.search(text, candidateLimit),
      this.vectors.search(vector, candidateLimit),
    ]);
    const candidates = new Map<string, RetrievalCandidate>();
    for (const hits of [textHits, vectorHits]) {
      hits.forEach((hit, rank) => {
        const existing = candidates.get(hit.chunkId);
        if (existing && existing.sourceId !== hit.sourceId) {
          throw new Error('Search indexes disagree about a chunk source; rebuild the indexes.');
        }
        const score = (existing?.score ?? 0) + 1 / (rank + 1);
        candidates.set(hit.chunkId, { chunkId: hit.chunkId, sourceId: hit.sourceId, score });
      });
    }
    return [...candidates.values()]
      .sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0))
      .slice(0, limit);
  }
}
