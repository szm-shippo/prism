import type { RetrievalCandidate } from './hybrid-retrieval';

export interface RerankInput extends RetrievalCandidate {
  content: string;
}

export type CandidateScorer = (query: string, candidates: readonly RerankInput[]) => Promise<readonly number[]>;

function occurrences(content: string, term: string): number {
  let count = 0;
  let position = 0;
  while ((position = content.indexOf(term, position)) !== -1) {
    count += 1;
    position += term.length;
  }
  return count;
}

export const lexicalCandidateScorer: CandidateScorer = async (query, candidates) => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return candidates.map(() => 0);
  const terms = [...new Set(normalized.split(/\s+/u).filter(Boolean))];
  return candidates.map(({ content }) => {
    const text = content.toLocaleLowerCase();
    return occurrences(text, normalized) * 2 +
      terms.reduce((score, term) => score + occurrences(text, term), 0);
  });
};

export class RetrievalReranker {
  constructor(
    private readonly getContent: (chunkId: string) => string | undefined,
    private readonly score: CandidateScorer = lexicalCandidateScorer,
  ) {}

  async rerank(query: string, candidates: readonly RetrievalCandidate[], topN: number): Promise<RetrievalCandidate[]> {
    if (!Number.isSafeInteger(topN) || topN < 0) {
      throw new Error('A non-negative rerank limit is required.');
    }
    if (topN === 0 || candidates.length === 0) return [];
    const fallback = candidates.slice(0, topN);
    if (!query.trim()) return fallback;
    try {
      const inputs = candidates.map((candidate) => {
        const content = this.getContent(candidate.chunkId);
        if (content === undefined) throw new Error('A retrieval candidate has no chunk content.');
        return { ...candidate, content };
      });
      const scores = await this.score(query, inputs);
      if (scores.length !== inputs.length || scores.some((score) => !Number.isFinite(score))) {
        throw new Error('Reranker returned invalid scores.');
      }
      return inputs.map((candidate, index) => ({ candidate, index, score: scores[index] }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, topN)
        .map(({ candidate }) => ({ chunkId: candidate.chunkId, sourceId: candidate.sourceId, score: candidate.score }));
    } catch {
      return fallback;
    }
  }
}
