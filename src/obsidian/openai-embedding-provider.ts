import { requestUrl, type RequestUrlResponse } from 'obsidian';
import type { EmbeddingProvider } from '../core/provider/embedding-provider';

type Request = typeof requestUrl;

export type EmbeddingErrorCode = 'authentication' | 'rate_limit' | 'unavailable' | 'invalid_request' | 'invalid_response';

const errorMessages: Record<EmbeddingErrorCode, string> = {
  authentication: 'Embedding provider authentication failed.',
  rate_limit: 'Embedding provider rate limit reached.',
  unavailable: 'Embedding provider is unavailable.',
  invalid_request: 'Embedding provider rejected the request.',
  invalid_response: 'Embedding provider returned an invalid response.',
};

export class EmbeddingProviderError extends Error {
  constructor(readonly code: EmbeddingErrorCode) {
    super(errorMessages[code]);
    this.name = 'EmbeddingProviderError';
  }
}

function responseError(status: number): EmbeddingProviderError {
  if (status === 401 || status === 403) return new EmbeddingProviderError('authentication');
  if (status === 429) return new EmbeddingProviderError('rate_limit');
  if (status >= 500) return new EmbeddingProviderError('unavailable');
  return new EmbeddingProviderError('invalid_request');
}

function parseVectors(response: RequestUrlResponse, count: number): number[][] {
  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new EmbeddingProviderError('invalid_response');
  }
  if (typeof payload !== 'object' || payload === null || !('data' in payload) ||
      !Array.isArray(payload.data) || payload.data.length !== count) {
    throw new EmbeddingProviderError('invalid_response');
  }
  const vectors: number[][] = Array.from({ length: count });
  for (const item of payload.data) {
    if (typeof item !== 'object' || item === null || !('index' in item) ||
        !Number.isInteger(item.index) || item.index < 0 || item.index >= count ||
        vectors[item.index] !== undefined || !('embedding' in item) ||
        !Array.isArray(item.embedding) || item.embedding.length === 0 ||
        !item.embedding.every((number: unknown) => typeof number === 'number' && Number.isFinite(number))) {
      throw new EmbeddingProviderError('invalid_response');
    }
    vectors[item.index] = item.embedding;
  }
  if (vectors.some((vector) => vector === undefined || vector.length !== vectors[0].length)) {
    throw new EmbeddingProviderError('invalid_response');
  }
  return vectors;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: { id: string };

  constructor(
    private readonly apiKey: string,
    modelId: string,
    private readonly request: Request = requestUrl,
  ) {
    if (!apiKey.trim() || !modelId.trim()) throw new Error('Embedding provider credentials and model are required.');
    this.model = { id: modelId };
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => !text.trim())) throw new EmbeddingProviderError('invalid_request');

    let response: RequestUrlResponse;
    try {
      response = await this.request({
        url: 'https://api.openai.com/v1/embeddings',
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model.id, input: texts, encoding_format: 'float' }),
        throw: false,
      });
    } catch {
      throw new EmbeddingProviderError('unavailable');
    }
    if (response.status < 200 || response.status >= 300) throw responseError(response.status);
    return parseVectors(response, texts.length);
  }
}
