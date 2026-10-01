export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMContext {
  sourceId: string;
  content: string;
  chunkId?: string;
}

export interface LLMRequest {
  messages: readonly LLMMessage[];
  context: readonly LLMContext[];
}

export interface LLMResponse {
  content: string;
}

export interface LLMProvider {
  generate(request: LLMRequest): Promise<LLMResponse>;
  /** Optional incremental output; a final response is still available through generate. */
  stream?(request: LLMRequest): AsyncIterable<string>;
}

export type LLMProviderErrorCode = 'authentication' | 'rate_limit' | 'unavailable' | 'invalid_request' | 'unknown';

const errorMessages: Record<LLMProviderErrorCode, string> = {
  authentication: 'LLM provider authentication failed.',
  rate_limit: 'LLM provider rate limit reached.',
  unavailable: 'LLM provider is unavailable.',
  invalid_request: 'LLM provider rejected the request.',
  unknown: 'LLM provider request failed.',
};

export class LLMProviderError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: LLMProviderErrorCode) {
    super(errorMessages[code]);
    this.name = 'LLMProviderError';
    this.retryable = code === 'rate_limit' || code === 'unavailable';
  }
}
