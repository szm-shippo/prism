import { Platform } from 'obsidian';
import { LLMProviderError, type LLMContext, type LLMMessage, type LLMProvider, type LLMRequest, type LLMResponse } from '../core/provider/llm-provider';
import type { CopilotAccount } from '../settings';
import type {
  CopilotAuthStatusRequest,
  CopilotGenerateRequest,
  CopilotModelInfo,
  CopilotModelListRequest,
  CopilotRuntimeErrorCode,
  CopilotSdkRuntime,
} from './copilot-sdk-runtime';

export interface CopilotLLMProviderOptions {
  cliPath: string;
  expectedAccount?: CopilotAccount;
  modelId?: string;
  sidecarPath: string;
  isDesktop?: () => boolean;
  onAuthenticationFailure?: () => void;
  runtime?: CopilotSdkRuntime;
}

function safeRuntimeError(error: unknown): LLMProviderError {
  if (error instanceof LLMProviderError) return error;
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
      typeof (runtime as CopilotSdkRuntime).getAuthStatus !== 'function' ||
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

  private runtimeError(error: unknown): LLMProviderError {
    const mapped = safeRuntimeError(error);
    if (mapped.code === 'authentication') this.options.onAuthenticationFailure?.();
    return mapped;
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

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.ensureDesktop();
    const controller = new AbortController();
    const pending = operation(controller.signal).finally(() => this.active.delete(controller));
    this.active.set(controller, pending);
    return pending;
  }

  async checkAuth(): Promise<CopilotAccount> {
    return this.run(async (signal) => {
      const runtime = await this.getRuntime();
      if (signal.aborted) throw new LLMProviderError('unknown');
      try {
        const request: CopilotAuthStatusRequest = { cliPath: this.options.cliPath, signal };
        const account = await runtime.getAuthStatus(request);
        if (signal.aborted) throw new LLMProviderError('unknown');
        return account;
      } catch (error) { throw this.runtimeError(error); }
    });
  }

  async listModels(): Promise<CopilotModelInfo[]> {
    return this.run(async (signal) => {
      if (!this.options.expectedAccount) throw new LLMProviderError('authentication');
      if (signal.aborted) throw new LLMProviderError('unknown');
      const runtime = await this.getRuntime();
      if (signal.aborted) throw new LLMProviderError('unknown');
      try {
        const request: CopilotModelListRequest = {
          cliPath: this.options.cliPath, expectedAccount: this.options.expectedAccount, signal,
        };
        const models = await runtime.listModels(request);
        if (signal.aborted) throw new LLMProviderError('unknown');
        return models.filter(({ id, name, policy }) => id.trim() && name.trim() && policy?.state !== 'disabled');
      } catch (error) { throw this.runtimeError(error); }
    });
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (request.messages.length === 0 || !request.messages.some((message) => message.role === 'user')) {
      throw new LLMProviderError('invalid_request');
    }
    const modelId = this.options.modelId?.trim();
    if (!modelId) throw new LLMProviderError('invalid_request');
    return this.run(async (signal) => {
      if (!this.options.expectedAccount) throw new LLMProviderError('authentication');
      if (signal.aborted) throw new LLMProviderError('unknown');
      const runtime = await this.getRuntime();
      if (signal.aborted) throw new LLMProviderError('unknown');
      try {
        const runtimeRequest: CopilotGenerateRequest = {
          cliPath: this.options.cliPath,
          expectedAccount: this.options.expectedAccount,
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
      } catch (error) { throw this.runtimeError(error); }
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
