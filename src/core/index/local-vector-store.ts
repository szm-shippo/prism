import { validateVectorDimensions, type VectorEntry, type VectorHit, type VectorStore } from './vector-store';

export interface VectorStoreState {
  dimensions: number;
  entries: VectorEntry[];
}

export interface VectorStoreStorage {
  load(): Promise<unknown>;
  save(state: VectorStoreState): Promise<void>;
}

function norm(values: readonly number[]): number {
  let result = 0;
  for (const value of values) result = Math.hypot(result, value);
  return result;
}

function validEntry(value: unknown, dimensions: number): value is VectorEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.chunkId !== 'string' || entry.chunkId.length === 0 ||
      typeof entry.sourceId !== 'string' || entry.sourceId.length === 0 || !Array.isArray(entry.values)) return false;
  if (entry.contentHash !== undefined && (typeof entry.contentHash !== 'string' || entry.contentHash.length === 0)) {
    return false;
  }
  try {
    validateVectorDimensions(entry.values, dimensions);
    const magnitude = norm(entry.values);
    return Number.isFinite(magnitude) && magnitude > 0;
  } catch {
    return false;
  }
}

function copy(entry: VectorEntry): VectorEntry {
  return {
    chunkId: entry.chunkId,
    sourceId: entry.sourceId,
    values: [...entry.values],
    ...(entry.contentHash === undefined ? {} : { contentHash: entry.contentHash }),
  };
}

export class LocalVectorStore implements VectorStore {
  private constructor(
    private readonly storage: VectorStoreStorage,
    readonly dimensions: number,
    private entries: VectorEntry[],
  ) {}

  static async open(storage: VectorStoreStorage, dimensions: number): Promise<LocalVectorStore> {
    if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
      throw new Error('A positive vector dimension is required.');
    }
    const loaded = await storage.load();
    if (loaded === undefined || loaded === null) return new LocalVectorStore(storage, dimensions, []);
    if (typeof loaded !== 'object' || Array.isArray(loaded) ||
        (loaded as VectorStoreState).dimensions !== dimensions ||
        !Array.isArray((loaded as VectorStoreState).entries) ||
        !(loaded as VectorStoreState).entries.every((entry) => validEntry(entry, dimensions)) ||
        new Set((loaded as VectorStoreState).entries.map((entry) => entry.chunkId)).size !==
          (loaded as VectorStoreState).entries.length) {
      throw new Error('Vector store data or dimensions are invalid; rebuild it from Vault Markdown.');
    }
    return new LocalVectorStore(storage, dimensions, (loaded as VectorStoreState).entries.map(copy));
  }

  async put(entries: readonly VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (!entries.every((entry) => validEntry(entry, this.dimensions)) ||
        new Set(entries.map((entry) => entry.chunkId)).size !== entries.length) {
      throw new Error(`Valid finite nonzero vectors with ${this.dimensions} dimensions and unique chunk IDs are required.`);
    }
    const next = this.entries.map(copy);
    for (const entry of entries) {
      const index = next.findIndex((item) => item.chunkId === entry.chunkId);
      if (index >= 0 && next[index].sourceId !== entry.sourceId) {
        throw new Error('Chunk ID already belongs to another source.');
      }
      if (index >= 0) next[index] = copy(entry);
      else next.push(copy(entry));
    }
    if (JSON.stringify(next) !== JSON.stringify(this.entries)) await this.commit(next);
  }

  async update(entries: readonly VectorEntry[]): Promise<void> {
    await this.put(entries);
  }

  async delete(chunkId: string): Promise<void> {
    const next = this.entries.filter((entry) => entry.chunkId !== chunkId);
    if (next.length !== this.entries.length) await this.commit(next);
  }

  async deleteBySource(sourceId: string): Promise<void> {
    const next = this.entries.filter((entry) => entry.sourceId !== sourceId);
    if (next.length !== this.entries.length) await this.commit(next);
  }

  listBySource(sourceId: string): VectorEntry[] {
    return this.entries.filter((entry) => entry.sourceId === sourceId).map(copy);
  }

  async search(query: readonly number[], limit: number): Promise<VectorHit[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('A non-negative search limit is required.');
    validateVectorDimensions(query, this.dimensions);
    const queryNorm = norm(query);
    if (!Number.isFinite(queryNorm) || queryNorm === 0) throw new Error('A nonzero finite query vector is required.');
    if (limit === 0) return [];
    return this.entries.map((entry) => {
      const entryNorm = norm(entry.values);
      let score = 0;
      for (let index = 0; index < this.dimensions; index += 1) {
        score += (entry.values[index] / entryNorm) * (query[index] / queryNorm);
      }
      return { chunkId: entry.chunkId, sourceId: entry.sourceId, score };
    }).sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0))
      .slice(0, limit);
  }

  async clear(): Promise<void> {
    if (this.entries.length > 0) await this.commit([]);
  }

  private async commit(entries: VectorEntry[]): Promise<void> {
    await this.storage.save({ dimensions: this.dimensions, entries });
    this.entries = entries;
  }
}
