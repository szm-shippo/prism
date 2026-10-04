import { Platform } from 'obsidian';
import { LLMProviderError, type LLMContext, type LLMMessage, type LLMProvider, type LLMRequest, type LLMResponse } from '../core/provider/llm-provider';
import type {
  CopilotGenerateRequest,
  CopilotModelInfo,
  CopilotModelListRequest,
  CopilotRuntimeErrorCode,
  CopilotSdkRuntime,
} from './copilot-sdk-runtime';

export interface CopilotLLMProviderOptions {
  getAccessToken: () => Promise<string>;
  cliPath: string;
  modelId?: string;
  sidecarPath: string;
  isDesktop?: () => boolean;
  runtime?: CopilotSdkRuntime;
}

function safeRuntimeError(error: unknown): LLMProviderError {
  if (error instanceof LLMProviderError) return error;
  if (error instanceof Error && error.name === 'CopilotAuthError') {
    const code = (error as Error & { code?: unknown }).code;
    if (code === 'authentication' || code === 'rate_limit' || code === 'unavailable') {
      return new LLMProviderError(code);
    }
  }
  if (error instanceof Error && error.name === 'CopilotRuntimeError') {
    const code = (error as Error & { code?: unknown }).code;
    if (code === 'authentication' || code === 'rate_limit' || code === 'quota' || code === 'usage_limit' ||
        code === 'context_limit' || code === 'invalid_request' || code === 'unavailable' || code === 'unknown') {
      return new LLMProviderError(code satisfies CopilotRuntimeErrorCode);
    }
  }
  return new LLMProviderError('unknown');
}

function runtimeFromSidecar(sidecarPath: string): CopilotSdkRuntime {
  let loaded: unknown;
  try { loaded = require(sidecarPath); }
  catch { throw new LLMProviderError('unavailable'); }
  if (!loaded || typeof loaded !== 'object') throw new LLMProviderError('unavailable');
  const runtime = (loaded as { copilotSdkRuntime?: unknown }).copilotSdkRuntime;
  if (!runtime || typeof runtime !== 'object' ||
      typeof (runtime as CopilotSdkRuntime).listModels !== 'function' ||
      typeof (runtime as CopilotSdkRuntime).generate !== 'function') {
    throw new LLMProviderError('unavailable');
  }
  return runtime as CopilotSdkRuntime;
}

export class CopilotLLMProvider implements LLMProvider {
  private runtime?: CopilotSdkRuntime;
  private runtimePromise?: Promise<CopilotSdkRuntime>;
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private disposed = false;
  private readonly isDesktop: () => boolean;

  constructor(private readonly options: CopilotLLMProviderOptions) {
    if (!options.cliPath.trim()) throw new Error('Choose the installed GitHub Copilot CLI executable in Prism settings.');
    if (!options.sidecarPath.trim() && !options.runtime) throw new Error('The GitHub Copilot runtime sidecar is unavailable.');
    this.runtime = options.runtime;
    this.isDesktop = options.isDesktop ?? (() => Platform.isDesktopApp);
  }

  private ensureDesktop(): void {
    if (!this.isDesktop() || this.disposed) throw new LLMProviderError('unavailable');
  }

  private async getRuntime(): Promise<CopilotSdkRuntime> {
    this.ensureDesktop();
    if (this.runtime) return this.runtime;
    this.runtimePromise ??= Promise.resolve().then(() => runtimeFromSidecar(this.options.sidecarPath));
    try {
      this.runtime = await this.runtimePromise;
      return this.runtime;
    } catch (error) {
      this.runtimePromise = undefined;
      throw safeRuntimeError(error);
    }
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new LLMProviderError('unknown');
    let abortHandler: (() => void) | undefined;
    let token: string;
    try {
      token = await Promise.race([
        this.options.getAccessToken(),
        new Promise<never>((_resolve, reject) => {
          abortHandler = () => reject(new LLMProviderError('unknown'));
          signal.addEventListener('abort', abortHandler, { once: true });
          if (signal.aborted) abortHandler();
        }),
      ]);
    } catch (error) {
      if (signal.aborted) throw new LLMProviderError('unknown');
      if (error instanceof LLMProviderError || (error instanceof Error && error.name === 'CopilotAuthError')) {
        throw safeRuntimeError(error);
      }
      throw new LLMProviderError('authentication');
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }
    if (signal.aborted) throw new LLMProviderError('unknown');
    if (!token.trim()) throw new LLMProviderError('authentication');
    return token;
  }

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.ensureDesktop();
    const controller = new AbortController();
    const pending = operation(controller.signal).finally(() => this.active.delete(controller));
    this.active.set(controller, pending);
    return pending;
  }

  async listModels(): Promise<CopilotModelInfo[]> {
    return this.run(async (signal) => {
      const token = await this.accessToken(signal);
      if (signal.aborted) throw new LLMProviderError('unknown');
      const runtime = await this.getRuntime();
      if (signal.aborted) throw new LLMProviderError('unknown');
      try {
        const request: CopilotModelListRequest = { cliPath: this.options.cliPath, token, signal };
        const models = await runtime.listModels(request);
        if (signal.aborted) throw new LLMProviderError('unknown');
        return models.filter(({ id, name, policy }) => id.trim() && name.trim() && policy?.state !== 'disabled');
      } catch (error) { throw safeRuntimeError(error); }
    });
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (request.messages.length === 0 || !request.messages.some((message) => message.role === 'user')) {
      throw new LLMProviderError('invalid_request');
    }
    const modelId = this.options.modelId?.trim();
    if (!modelId) throw new LLMProviderError('invalid_request');
    return this.run(async (signal) => {
      const token = await this.accessToken(signal);
      if (signal.aborted) throw new LLMProviderError('unknown');
      const runtime = await this.getRuntime();
      if (signal.aborted) throw new LLMProviderError('unknown');
      try {
        const runtimeRequest: CopilotGenerateRequest = {
          cliPath: this.options.cliPath,
          token,
          modelId,
          messages: request.messages as readonly LLMMessage[],
          context: request.context as readonly LLMContext[],
          signal,
        };
        const response = await runtime.generate(runtimeRequest);
        if (signal.aborted) throw new LLMProviderError('unknown');
        if (!response || typeof response.content !== 'string' ||
            (!response.content.trim() && !response.incompleteReason)) {
          throw new LLMProviderError('unknown');
        }
        if (response.incompleteReason !== undefined &&
            response.incompleteReason !== 'output_limit' && response.incompleteReason !== 'unknown') {
          throw new LLMProviderError('unknown');
        }
        return response;
      } catch (error) { throw safeRuntimeError(error); }
    });
  }

  async cancel(): Promise<void> {
    const running = [...this.active.entries()];
    for (const [controller] of running) controller.abort();
    await Promise.allSettled(running.map(([, request]) => request));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    this.runtime = undefined;
    this.runtimePromise = undefined;
  }
}
