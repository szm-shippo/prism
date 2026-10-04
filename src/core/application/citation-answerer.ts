import type { ChunkRegistry } from '../index/chunk-registry';
import type { LLMProvider, LLMResponse } from '../provider/llm-provider';
import { QueryAnswerer } from './query-answerer';
import type { ConversationExchange } from './conversation-history';

export interface CitedChunk {
  chunkId: string;
  sourceId: string;
  content: string;
}

export interface SourceCitation {
  chunkId: string;
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface CitedAnswer extends LLMResponse {
  citations: SourceCitation[];
}

export class CitationAnswerer {
  constructor(
    private readonly provider: Pick<LLMProvider, 'generate'>,
    private readonly chunks: Pick<ChunkRegistry, 'provenance'>,
    private readonly sourceExists: (path: string) => boolean,
  ) {}

  async answer(query: string, usedChunks: readonly CitedChunk[], history: readonly ConversationExchange[] = []): Promise<CitedAnswer> {
    if (new Set(usedChunks.map(({ chunkId }) => chunkId)).size !== usedChunks.length ||
        usedChunks.some(({ chunkId, sourceId }) => !chunkId.trim() || !sourceId.trim())) {
      throw new Error('Cited chunks need unique chunk IDs and source IDs.');
    }
    const context = usedChunks.map(({ chunkId, sourceId, content }) => ({ chunkId, sourceId, content }));
    const answerer = new QueryAnswerer({
      generate: (request) => this.provider.generate({
        ...request,
        messages: [{
          role: 'system',
          content: 'After each claim supported by reference material, write [cite:CHUNK_ID] using the exact chunkId of the supporting reference. Do not cite a reference you did not use.',
        }, ...request.messages],
      }),
    });
    const response = await answerer.answer(query, context, history);
    const available = new Map(usedChunks.map((chunk) => [chunk.chunkId, chunk.sourceId]));
    const citations = new Map<string, SourceCitation>();
    const content = response.content.replace(/\[cite:([^\]\r\n]+)\]/gu, (_marker, chunkId: string) => {
      const sourceId = available.get(chunkId);
      if (!sourceId) return '';
      const provenance = this.chunks.provenance(chunkId);
      if (!provenance || provenance.sourceId !== sourceId || !this.sourceExists(provenance.path)) return '';
      if (!citations.has(chunkId)) citations.set(chunkId, { chunkId, ...provenance });
      return `[^${[...citations.keys()].indexOf(chunkId) + 1}]`;
    });
    return { ...response, content, citations: [...citations.values()] };
  }
}
