import type { MarkdownChunk } from './markdown-chunker';

export interface FullTextHit {
  chunkId: string;
  sourceId: string;
  score: number;
}

export interface FullTextSearch {
  index(chunks: readonly MarkdownChunk[]): Promise<void>;
  update(chunks: readonly MarkdownChunk[]): Promise<void>;
  deleteBySource(sourceId: string): Promise<void>;
  search(query: string, limit: number): Promise<FullTextHit[]>;
  clear(): Promise<void>;
}
