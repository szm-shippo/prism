import type { CitedAnswer, CitedChunk, CitationAnswerer } from './citation-answerer';
import type { ChunkRegistry } from '../index/chunk-registry';
import type { HybridRetrieval } from '../index/hybrid-retrieval';
import type { RetrievalReranker } from '../index/retrieval-reranker';

export interface RagLimits {
  candidates: number;
  contextChunks: number;
  contextTokens: number;
}

const DEFAULT_LIMITS: RagLimits = { candidates: 20, contextChunks: 6, contextTokens: 6000 };

export class RagPipeline {
  private readonly limits: RagLimits;

  constructor(
    private readonly vectorize: (query: string) => Promise<readonly number[]>,
    private readonly retrieval: Pick<HybridRetrieval, 'retrieve'>,
    private readonly reranker: Pick<RetrievalReranker, 'rerank'>,
    private readonly chunks: Pick<ChunkRegistry, 'get'>,
    private readonly answerer: Pick<CitationAnswerer, 'answer'>,
    limits: RagLimits = DEFAULT_LIMITS,
  ) {
    if (![limits.candidates, limits.contextChunks, limits.contextTokens]
      .every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Positive RAG candidate, chunk, and context token limits are required.');
    }
    this.limits = { ...limits };
  }

  async answer(query: string): Promise<CitedAnswer> {
    const question = query.trim();
    if (!question) throw new Error('A non-empty query is required.');
    const vector = await this.vectorize(question);
    const candidates = await this.retrieval.retrieve(question, vector, this.limits.candidates);
    const ranked = await this.reranker.rerank(question, candidates, this.limits.contextChunks);
    const context: CitedChunk[] = [];
    for (const candidate of ranked) {
      const chunk = this.chunks.get(candidate.chunkId);
      if (!chunk) continue;
      if (chunk.source_id !== candidate.sourceId) {
        throw new Error('A retrieval candidate has conflicting source provenance; rebuild the indexes.');
      }
      const item = { chunkId: chunk.chunk_id, sourceId: chunk.source_id, content: chunk.content };
      const cost = new TextEncoder().encode(JSON.stringify([...context, item])).length;
      if (cost > this.limits.contextTokens) continue;
      context.push(item);
    }
    return this.answerer.answer(question, context);
  }
}
