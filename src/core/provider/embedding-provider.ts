export interface EmbeddingModel {
  /** Provider-specific model identifier used to produce the vectors. */
  id: string;
  /** Vector length, when known before the first request. */
  dimensions?: number;
}

export interface EmbeddingProvider {
  readonly model: EmbeddingModel;
  embed(text: string): Promise<number[]>;
  /** Returns one vector per input, in the same order. Empty input returns an empty array. */
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}
