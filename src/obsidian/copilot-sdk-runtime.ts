import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type ModelInfo,
  type SessionConfig,
} from '@github/copilot-sdk';
import type { LLMContext, LLMMessage, LLMResponse } from '../core/provider/llm-provider';
import type { CopilotAccount } from '../settings';

interface RuntimeSession {
  sessionId: string;
  on(event: 'session.idle', handler: (event: { data: { aborted?: boolean } }) => void): () => void;
  on(event: 'session.error', handler: (event: { data: { errorType: string } }) => void): () => void;
  on(event: 'assistant.usage', handler: (event: { data: { finishReason?: string; contentFilterTriggered?: boolean } }) => void): () => void;
  sendAndWait(options: { prompt: string }, timeoutMs: number): Promise<{ data: { content?: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

interface RuntimeClient {
  start(): Promise<void>;
  getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    authType?: string;
    host?: string;
    login?: string;
  }>;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: SessionConfig): Promise<RuntimeSession>;
  deleteSession(sessionId: string): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
}

interface RuntimeWorkspace {
  root: string;
  workingDirectory: string;
  configDirectory: string;
  providersConfigFile: string;
}

export interface CopilotSdkBindings {
  createClient?: (options: CopilotClientOptions) => RuntimeClient;
  stdioConnection?: (path: string) => CopilotClientOptions['connection'];
  afterWorkspaceCreated?: (workspace: RuntimeWorkspace) => Promise<void> | void;
}

type ResolvedCopilotSdkBindings = Required<Pick<CopilotSdkBindings, 'createClient' | 'stdioConnection'>> &
  Pick<CopilotSdkBindings, 'afterWorkspaceCreated'>;

const defaultBindings: ResolvedCopilotSdkBindings = {
  createClient: (options) => new CopilotClient(options) as unknown as RuntimeClient,
  stdioConnection: (path) => RuntimeConnection.forStdio({ path }),
};

export type CopilotModelInfo = Pick<ModelInfo, 'id' | 'name'> & {
  policy?: Pick<NonNullable<ModelInfo['policy']>, 'state'>;
};

export interface CopilotAuthStatusRequest {
  cliPath: string;
  signal?: AbortSignal;
}

export interface CopilotModelListRequest extends CopilotAuthStatusRequest {
  expectedAccount: CopilotAccount;
}

export interface CopilotGenerateRequest extends CopilotModelListRequest {
  modelId: string;
  messages: readonly LLMMessage[];
  context: readonly LLMContext[];
}

export interface CopilotSdkRuntime {
  getAuthStatus(request: CopilotAuthStatusRequest): Promise<CopilotAccount>;
  listModels(request: CopilotModelListRequest): Promise<CopilotModelInfo[]>;
  generate(request: CopilotGenerateRequest): Promise<LLMResponse>;
}

export type CopilotRuntimeErrorCode =
  | 'authentication' | 'rate_limit' | 'quota' | 'usage_limit' | 'context_limit'
  | 'invalid_request' | 'unavailable' | 'unknown';

const SAFE_RUNTIME_MESSAGES: Record<CopilotRuntimeErrorCode, string> = {
  authentication: 'GitHub Copilot authentication failed.',
  rate_limit: 'GitHub Copilot rate limit reached.',
  quota: 'GitHub Copilot quota reached.',
  usage_limit: 'GitHub Copilot rate limit or quota reached.',
  context_limit: 'GitHub Copilot context limit exceeded.',
  invalid_request: 'GitHub Copilot rejected the request.',
  unavailable: 'GitHub Copilot is unavailable.',
  unknown: 'GitHub Copilot request failed.',
};

export class CopilotRuntimeError extends Error {
  constructor(readonly code: CopilotRuntimeErrorCode) {
    super(SAFE_RUNTIME_MESSAGES[code]);
    this.name = 'CopilotRuntimeError';
  }
}

const MODEL_LIST_TIMEOUT_MS = 60_000;
const GENERATION_TIMEOUT_MS = 90_000;
const SEND_TIMEOUT_MS = 60_000;
const CLIENT_STOP_TIMEOUT_MS = 5_000;
const TEMP_DIRECTORY_PREFIX = 'prism-copilot-';
const SDK_ABORT_FEEDBACK = 'Prism Ask does not run tools.';

const ALLOWED_ENV_NAMES = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir',
  'userprofile', 'home', 'appdata', 'localappdata', 'programdata',
  'homedrive', 'homepath', 'lang', 'lc_all', 'tz',
  'http_proxy', 'https_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir',
  'node_extra_ca_certs', 'curl_ca_bundle',
]);

function runtimeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  const included = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toLowerCase();
    if ((!ALLOWED_ENV_NAMES.has(normalized) && !normalized.startsWith('xdg_')) || included.has(normalized)) continue;
    result[name] = value;
    included.add(normalized);
  }
  return result;
}

async function validateRequest(cliPath: string): Promise<void> {
  if (!cliPath.trim() || !isAbsolute(cliPath) || extname(cliPath).toLowerCase() === '.js') {
    throw new CopilotRuntimeError('invalid_request');
  }
  try {
    const file = await stat(cliPath);
    if (!file.isFile()) throw new Error();
  } catch {
    throw new CopilotRuntimeError('invalid_request');
  }
}

function isGitHubDotComHost(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const source = value.trim();
    const url = new URL(source.includes('://') ? source : `https://${source}`);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' &&
      (!url.port || url.port === '443') && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

function copilotUserIdentity(status: unknown): CopilotAccount {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new CopilotRuntimeError('authentication');
  }
  const value = status as Record<string, unknown>;
  const login = typeof value.login === 'string' ? value.login.trim() : '';
  if (value.isAuthenticated !== true || value.authType !== 'user' || !isGitHubDotComHost(value.host) ||
      !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    throw new CopilotRuntimeError('authentication');
  }
  return { host: 'github.com', login };
}

function requireExpectedCopilotUser(status: unknown, expectedAccount: CopilotAccount): CopilotAccount {
  const actual = copilotUserIdentity(status);
  if (expectedAccount.host !== 'github.com' ||
      !/^[A-Za-z0-9-]{1,39}$/.test(expectedAccount.login.trim()) ||
      actual.login.toLowerCase() !== expectedAccount.login.trim().toLowerCase()) {
    throw new CopilotRuntimeError('authentication');
  }
  return actual;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CopilotRuntimeError('unknown');
}

async function quietly(action: () => Promise<unknown> | unknown): Promise<void> {
  try { await action(); } catch { /* Cleanup must not replace the original result. */ }
}

async function stopClient(client: RuntimeClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: Promise<{ errors: Error[] }>;
  try { stop = Promise.resolve(client.stop()).then((errors) => ({ errors })); }
  catch { stop = Promise.resolve({ errors: [new Error()] }); }
  const timeout = new Promise<{ timedOut: true }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), CLIENT_STOP_TIMEOUT_MS);
  });
  let stopped: { errors: Error[] } | { timedOut: true };
  try { stopped = await Promise.race([stop, timeout]); }
  catch { stopped = { timedOut: true }; }
  finally { if (timer !== undefined) clearTimeout(timer); }
  if ('timedOut' in stopped || stopped.errors.length > 0) {
    try { await client.forceStop(); }
    catch { throw new CopilotRuntimeError('unavailable'); }
  }
}

function removeOwnedWorkspace(path: string): Promise<void> {
  const resolved = resolve(path);
  const fromTemp = relative(resolve(tmpdir()), resolved);
  if (!basename(resolved).startsWith(TEMP_DIRECTORY_PREFIX) || fromTemp !== basename(resolved) || !fromTemp ||
      fromTemp === '..' || fromTemp.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromTemp)) {
    throw new CopilotRuntimeError('unavailable');
  }
  return rm(resolved, { recursive: true, force: true });
}

function runtimeCodeForSessionError(errorType: string): CopilotRuntimeErrorCode {
  switch (errorType) {
    case 'authentication':
    case 'authorization': return 'authentication';
    case 'rate_limit': return 'rate_limit';
    case 'quota': return 'quota';
    case 'context_limit': return 'context_limit';
    case 'query': return 'invalid_request';
    default: return 'unknown';
  }
}

function runtimeCodeForThrown(error: unknown): CopilotRuntimeErrorCode {
  if (!error || typeof error !== 'object') return 'unknown';
  const details = error as Record<string, unknown>;
  const data = details.data && typeof details.data === 'object' ? details.data as Record<string, unknown> : undefined;
  const structuredType = [details.errorType, data?.errorType]
    .find((value): value is string => typeof value === 'string');
  if (structuredType) {
    const mapped = runtimeCodeForSessionError(structuredType.toLowerCase());
    if (mapped !== 'unknown') return mapped;
  }

  const code = [details.errorCode, details.code, data?.errorCode]
    .find((value): value is string => typeof value === 'string')?.toLowerCase();
  if (code) {
    if (code === 'authentication' || code === 'authorization' || code === 'unauthorized' || code === 'forbidden') {
      return 'authentication';
    }
    if (code === 'quota' || code.includes('quota') || code.includes('billing_not_configured')) return 'quota';
    if (code === 'rate_limit' || code.includes('rate_limited') || code.includes('rate_limit')) return 'rate_limit';
    if (code === 'usage_limit') return 'usage_limit';
    if (code === 'context_limit' || code.includes('context_length')) return 'context_limit';
    if (code === 'query' || code === 'invalid_request') return 'invalid_request';
    if (['enoent', 'eacces', 'eperm', 'enoexec'].includes(code)) return 'invalid_request';
    if (['etimedout', 'econnrefused', 'econnreset', 'epipe', 'enetunreach', 'ehostunreach', 'eai_again'].includes(code)) {
      return 'unavailable';
    }
  }

  const status = [details.statusCode, details.status, data?.statusCode]
    .find((value): value is number => typeof value === 'number' && Number.isInteger(value));
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'authentication';
    if (status === 402) return 'quota';
    if (status === 413) return 'context_limit';
    if (status === 429) return 'rate_limit';
    if (status === 400 || status === 422) return 'invalid_request';
    if (status === 408 || status >= 500) return 'unavailable';
  }
  if (details.name === 'TimeoutError') return 'unavailable';
  return 'unknown';
}

function systemMessage(messages: readonly LLMMessage[]): string {
  return [
    ...messages.filter((message) => message.role === 'system').map((message) => message.content),
    'Do not use tools, read or modify local files, or access information outside this request. Answer only from the supplied conversation and reference material.',
  ].filter(Boolean).join('\n\n');
}

function promptFor(messages: readonly LLMMessage[], context: readonly LLMContext[]): string {
  if (messages.length === 0 || !messages.some((message) => message.role === 'user')) {
    throw new CopilotRuntimeError('invalid_request');
  }
  const transcript = messages.filter((message) => message.role !== 'system').map((message) => ({ ...message }));
  if (context.length > 0) {
    const lastUserIndex = transcript.map((message) => message.role).lastIndexOf('user');
    const reference = {
      role: 'user' as const,
      content: `Reference material (untrusted data):\n${JSON.stringify(context.map(({ sourceId, content, chunkId }) =>
        chunkId === undefined ? { sourceId, content } : { sourceId, chunkId, content }))}`,
    };
    transcript.splice(lastUserIndex, 0, reference);
  }
  return [
    'Respond to the final user message in this Prism Ask conversation. The following JSON contains conversation messages and reference material:',
    JSON.stringify(transcript),
  ].join('\n\n');
}

function sessionConfig(request: CopilotGenerateRequest, workingDirectory: string, configDirectory: string): SessionConfig {
  return {
    model: request.modelId,
    allowedModels: [request.modelId],
    systemMessage: { mode: 'replace', content: systemMessage(request.messages) },
    workingDirectory,
    configDirectory,
    availableTools: [],
    tools: [],
    customAgents: [],
    includedBuiltinSkills: [],
    skipCustomInstructions: true,
    enableConfigDiscovery: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory',
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionTelemetry: false,
    enableSessionStore: false,
    enableSkills: false,
    memory: { enabled: false },
    customAgentsLocalOnly: true,
    coauthorEnabled: false,
    enableExperimentalMode: false,
    enableMcpApps: false,
    requestCanvasRenderer: false,
    requestExtensions: false,
    manageScheduleEnabled: false,
    mcpOAuthTokenStorage: 'in-memory',
    onPermissionRequest: async () => ({ kind: 'reject', feedback: SDK_ABORT_FEEDBACK }),
    hooks: {
      onPreToolUse: async () => ({ permissionDecision: 'deny', permissionDecisionReason: SDK_ABORT_FEEDBACK }),
    },
  };
}

async function createClientWorkspace(): Promise<RuntimeWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'prism-copilot-'));
  try {
    const workingDirectory = join(root, 'workspace');
    const configDirectory = join(root, 'session-config');
    const providersConfigFile = join(root, 'providers.json');
    await Promise.all([
      mkdir(workingDirectory),
      mkdir(configDirectory),
      writeFile(providersConfigFile, JSON.stringify({ providers: [], models: [] }), { encoding: 'utf8', flag: 'wx' }),
    ]);
    return { root, workingDirectory, configDirectory, providersConfigFile };
  } catch {
    await quietly(() => removeOwnedWorkspace(root));
    throw new CopilotRuntimeError('unavailable');
  }
}

async function withClient<T>(
  request: CopilotAuthStatusRequest,
  action: (client: RuntimeClient, workspace: RuntimeWorkspace, signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  bindings: ResolvedCopilotSdkBindings,
): Promise<T> {
  await validateRequest(request.cliPath);
  throwIfAborted(request.signal);
  const workspace = await createClientWorkspace();
  try {
    await bindings.afterWorkspaceCreated?.(workspace);
  } catch {
    await quietly(() => removeOwnedWorkspace(workspace.root));
    throw new CopilotRuntimeError('unavailable');
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  request.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (request.signal?.aborted) abortFromCaller();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let client: RuntimeClient | undefined;
  let actionPromise: Promise<T> | undefined;
  let stopPromise: Promise<void> | undefined;
  let rejectOnAbort: ((error: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectOnAbort = reject; });
  void abortPromise.catch(() => undefined);
  const stopOnAbort = () => {
    rejectOnAbort?.(new CopilotRuntimeError(timedOut ? 'unavailable' : 'unknown'));
    if (client) stopPromise ??= Promise.resolve().then(() => stopClient(client!));
  };
  controller.signal.addEventListener('abort', stopOnAbort, { once: true });
  if (controller.signal.aborted) stopOnAbort();
  try {
    throwIfAborted(controller.signal);
    const options: CopilotClientOptions = {
      connection: bindings.stdioConnection(request.cliPath),
      mode: 'copilot-cli',
      workingDirectory: workspace.workingDirectory,
      logLevel: 'none',
      env: {
        ...runtimeEnvironment(),
        COPILOT_PROVIDERS_CONFIG: workspace.providersConfigFile,
      },
      useLoggedInUser: true,
    };
    client = bindings.createClient(options);
    throwIfAborted(controller.signal);
    actionPromise = action(client, workspace, controller.signal);
    void actionPromise.catch(() => undefined);
    return await Promise.race([actionPromise, abortPromise]);
  } catch (error) {
    if (timedOut) throw new CopilotRuntimeError('unavailable');
    if (error instanceof CopilotRuntimeError) throw error;
    if (request.signal?.aborted) throw new CopilotRuntimeError('unknown');
    throw new CopilotRuntimeError(runtimeCodeForThrown(error));
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abortFromCaller);
    controller.signal.removeEventListener('abort', stopOnAbort);
    try {
      if (client) {
        stopPromise ??= stopClient(client);
        await stopPromise;
      }
      await removeOwnedWorkspace(workspace.root);
    } catch {
      throw new CopilotRuntimeError('unavailable');
    }
  }
}

export function createCopilotSdkRuntime(overrides: CopilotSdkBindings = {}): CopilotSdkRuntime {
  const bindings: ResolvedCopilotSdkBindings = { ...defaultBindings, ...overrides };
  return {
    async getAuthStatus(request): Promise<CopilotAccount> {
      return withClient(request, async (client, _workspace, signal) => {
        await client.start();
        throwIfAborted(signal);
        const status = await client.getAuthStatus();
        throwIfAborted(signal);
        return copilotUserIdentity(status);
      }, MODEL_LIST_TIMEOUT_MS, bindings);
    },

    async listModels(request): Promise<CopilotModelInfo[]> {
      return withClient(request, async (client, _workspace, signal) => {
        await client.start();
        throwIfAborted(signal);
        requireExpectedCopilotUser(await client.getAuthStatus(), request.expectedAccount);
        throwIfAborted(signal);
        const models = await client.listModels();
        throwIfAborted(signal);
        return models.filter((model) => model.policy?.state !== 'disabled').map(({ id, name, policy }) => ({
          id, name, ...(policy ? { policy: { state: policy.state } } : {}),
        }));
      }, MODEL_LIST_TIMEOUT_MS, bindings);
    },

    async generate(request): Promise<LLMResponse> {
      if (!request.modelId.trim()) throw new CopilotRuntimeError('invalid_request');
      const prompt = promptFor(request.messages, request.context);
      return withClient(request, async (client, workspace, signal) => {
        let session: RuntimeSession | undefined;
        let idleAborted = false;
        let requestTimedOut = false;
        let outputLimitReached = false;
        let contentFilterReached = false;
        let runtimeFailure: CopilotRuntimeErrorCode | undefined;
        const abortSession = () => {
          if (session) void quietly(() => session!.abort());
        };
        signal.addEventListener('abort', abortSession, { once: true });
        let unsubscribeIdle: (() => void) | undefined;
        let unsubscribeError: (() => void) | undefined;
        let unsubscribeUsage: (() => void) | undefined;
        try {
          await client.start();
          throwIfAborted(signal);
          requireExpectedCopilotUser(await client.getAuthStatus(), request.expectedAccount);
          throwIfAborted(signal);
          session = await client.createSession(sessionConfig(request, workspace.workingDirectory, workspace.configDirectory));
          unsubscribeIdle = session.on('session.idle', (event) => {
            if (event.data.aborted) idleAborted = true;
          });
          unsubscribeError = session.on('session.error', (event) => {
            runtimeFailure = runtimeCodeForSessionError(event.data.errorType);
          });
          unsubscribeUsage = session.on('assistant.usage', (event) => {
            outputLimitReached = event.data.finishReason === 'length';
            contentFilterReached = event.data.contentFilterTriggered === true || event.data.finishReason === 'content_filter';
          });
          throwIfAborted(signal);
          const response = await session.sendAndWait({ prompt }, SEND_TIMEOUT_MS);
          if (signal.aborted || idleAborted) throw new CopilotRuntimeError('unknown');
          if (runtimeFailure) throw new CopilotRuntimeError(runtimeFailure);
          const content = response?.data.content;
          if (typeof content !== 'string' || !content.trim()) throw new CopilotRuntimeError('unknown');
          if (contentFilterReached) return { content, incompleteReason: 'unknown' };
          if (outputLimitReached) return { content, incompleteReason: 'output_limit' };
          return { content };
        } catch (error) {
          if (error instanceof CopilotRuntimeError) throw error;
          if (signal.aborted || idleAborted) throw new CopilotRuntimeError('unknown');
          if (runtimeFailure) throw new CopilotRuntimeError(runtimeFailure);
          if (error instanceof Error && error.message.startsWith('Timeout after ')) {
            requestTimedOut = true;
            throw new CopilotRuntimeError('unavailable');
          }
          throw new CopilotRuntimeError(runtimeCodeForThrown(error));
        } finally {
          signal.removeEventListener('abort', abortSession);
          unsubscribeIdle?.();
          unsubscribeError?.();
          unsubscribeUsage?.();
          if (session) {
            if (signal.aborted || requestTimedOut) await quietly(() => session!.abort());
            await quietly(() => session!.disconnect());
            await quietly(() => client.deleteSession(session!.sessionId));
          }
        }
      }, GENERATION_TIMEOUT_MS, bindings);
    },
  };
}

export const copilotSdkRuntime = createCopilotSdkRuntime();
