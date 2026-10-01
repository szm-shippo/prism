export interface VectorEntry {
  chunkId: string;
  sourceId: string;
  values: readonly number[];
  contentHash?: string;
}

export interface VectorHit {
  chunkId: string;
  sourceId: string;
  score: number;
}

export interface VectorStore {
  /** All stored and query vectors must match this dimension. */
  readonly dimensions: number;
  put(entries: readonly VectorEntry[]): Promise<void>;
  update(entries: readonly VectorEntry[]): Promise<void>;
  delete(chunkId: string): Promise<void>;
  deleteBySource(sourceId: string): Promise<void>;
  listBySource(sourceId: string): VectorEntry[];
  search(query: readonly number[], limit: number): Promise<VectorHit[]>;
  clear(): Promise<void>;
}

export function validateVectorDimensions(vector: readonly number[], dimensions: number): void {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || vector.length !== dimensions ||
      vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Expected a finite vector with ${dimensions} dimensions.`);
  }
}
