import type { MarkdownChunk } from './markdown-chunker';
import type { FullTextHit, FullTextSearch } from './full-text-search';

export interface FullTextSearchEntry {
  chunkId: string;
  sourceId: string;
  content: string;
}

export interface FullTextSearchStorage {
  load(): Promise<unknown>;
  save(entries: readonly FullTextSearchEntry[]): Promise<void>;
}

function validEntry(value: unknown): value is FullTextSearchEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.chunkId === 'string' && entry.chunkId.length > 0 &&
    typeof entry.sourceId === 'string' && entry.sourceId.length > 0 &&
    typeof entry.content === 'string';
}

function occurrences(content: string, term: string): number {
  let count = 0;
  let position = 0;
  while ((position = content.indexOf(term, position)) >= 0) {
    count += 1;
    position += term.length;
  }
  return count;
}

export class LocalFullTextSearch implements FullTextSearch {
  private constructor(
    private readonly storage: FullTextSearchStorage,
    private entries: FullTextSearchEntry[],
  ) {}

  static async open(storage: FullTextSearchStorage): Promise<LocalFullTextSearch> {
    const loaded = await storage.load();
    if (loaded === undefined || loaded === null) return new LocalFullTextSearch(storage, []);
    if (!Array.isArray(loaded) || !loaded.every(validEntry) ||
        new Set(loaded.map((entry) => entry.chunkId)).size !== loaded.length) {
      throw new Error('Full-text index data is invalid; rebuild it from Vault Markdown.');
    }
    return new LocalFullTextSearch(storage, loaded.map((entry) => ({ ...entry })));
  }

  async index(chunks: readonly MarkdownChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    if (!chunks.every((chunk) => chunk && validEntry({
      chunkId: chunk.chunk_id, sourceId: chunk.source_id, content: chunk.content,
    })) || new Set(chunks.map((chunk) => chunk.chunk_id)).size !== chunks.length) {
      throw new Error('Valid chunks with unique IDs are required for indexing.');
    }
    const next = this.entries.map((entry) => ({ ...entry }));
    for (const chunk of chunks) {
      const index = next.findIndex((entry) => entry.chunkId === chunk.chunk_id);
      if (index >= 0 && next[index].sourceId !== chunk.source_id) {
        throw new Error('Chunk ID already belongs to another source.');
      }
      const entry = { chunkId: chunk.chunk_id, sourceId: chunk.source_id, content: chunk.content };
      if (index >= 0) next[index] = entry;
      else next.push(entry);
    }
    if (JSON.stringify(next) !== JSON.stringify(this.entries)) await this.commit(next);
  }

  async update(chunks: readonly MarkdownChunk[]): Promise<void> {
    await this.index(chunks);
  }

  async deleteBySource(sourceId: string): Promise<void> {
    const next = this.entries.filter((entry) => entry.sourceId !== sourceId);
    if (next.length !== this.entries.length) await this.commit(next);
  }

  async search(query: string, limit: number): Promise<FullTextHit[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('A non-negative search limit is required.');
    const normalized = query.trim().toLowerCase();
    if (!normalized || limit === 0) return [];
    const terms = [...new Set(normalized.split(/\s+/u))];
    return this.entries.flatMap((entry) => {
      const content = entry.content.toLowerCase();
      const score = occurrences(content, normalized) * 2 +
        terms.reduce((total, term) => total + occurrences(content, term), 0);
      return score > 0 ? [{ chunkId: entry.chunkId, sourceId: entry.sourceId, score }] : [];
    }).sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0)).slice(0, limit);
  }

  async clear(): Promise<void> {
    if (this.entries.length > 0) await this.commit([]);
  }

  private async commit(next: FullTextSearchEntry[]): Promise<void> {
    await this.storage.save(next);
    this.entries = next;
  }
}
