import { LLMProviderError, type LLMProviderErrorCode, type LLMResponse } from '../core/provider/llm-provider';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function parsePayload(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function providerError(payload: unknown, fallback: LLMProviderErrorCode): LLMProviderError {
  const body = record(payload);
  const error = record(body.error);
  const code = error.code ?? error.type ?? body.code;
  switch (code) {
    case 'context_length_exceeded': return new LLMProviderError('context_limit');
    case 'insufficient_quota': return new LLMProviderError('quota');
    case 'usage_limit_reached': return new LLMProviderError('quota');
    case 'rate_limit_exceeded': return new LLMProviderError('rate_limit');
    default: return new LLMProviderError(fallback);
  }
}

export function responseOutput(payload: unknown, fallbackContent = '', forceIncomplete = false): LLMResponse {
  const body = record(payload);
  if (body.status === 'failed' || body.error) throw providerError(body, 'unknown');
  const incomplete = forceIncomplete || body.status === 'incomplete';
  if (body.status !== undefined && body.status !== 'completed' && body.status !== 'incomplete') {
    throw new LLMProviderError('unknown');
  }
  const parts: string[] = [];
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      const message = record(item);
      if (message.type !== 'message') continue;
      if (!Array.isArray(message.content)) throw new LLMProviderError('unknown');
      for (const item of message.content) {
        const content = record(item);
        if (content.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
      }
    }
  }
  const content = parts.length ? parts.join('') : fallbackContent;
  if (!content.trim() && !incomplete) throw new LLMProviderError('unknown');
  if (incomplete) return {
    content,
    incompleteReason: record(body.incomplete_details).reason === 'max_output_tokens' ? 'output_limit' : 'unknown',
  };
  return { content };
}
