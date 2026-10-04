import { requestUrl } from 'obsidian';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const ACCOUNT_URL = 'https://api.github.com/user';
const DEVICE_URL = 'https://github.com/login/device';
const SECRET_ID = 'prism-copilot-credential';
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;

type Transport = typeof requestUrl;
type SecretStore = { getSecret(id: string): string | null; setSecret(id: string, value: string): void };
type Clock = {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
};

export interface CopilotAccount {
  id: string;
  login: string;
}

export interface CopilotCredential extends CopilotAccount {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
}

export interface CopilotDevicePrompt {
  userCode: string;
  verificationUrl: string;
  complete: Promise<void>;
  cancel(): void;
}

export type CopilotAuthErrorCode = 'authentication' | 'rate_limit' | 'unavailable';

const AUTH_ERROR_MESSAGES: Record<CopilotAuthErrorCode, string> = {
  authentication: 'GitHub authorization is invalid or expired. Sign in again.',
  rate_limit: 'GitHub rate limited authorization. Try again later.',
  unavailable: 'GitHub authorization is temporarily unavailable. Try again later.',
};

export class CopilotAuthError extends Error {
  constructor(readonly code: CopilotAuthErrorCode) {
    super(AUTH_ERROR_MESSAGES[code]);
    this.name = 'CopilotAuthError';
  }
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('GitHub authorization was canceled.')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(new Error('GitHub authorization was canceled.')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

const defaultClock: Clock = { now: () => Date.now(), wait: defaultWait };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub response.');
  return value as Record<string, unknown>;
}

function parseJson(text: string): Record<string, unknown> {
  try { return record(JSON.parse(text)); } catch { throw new Error('Invalid GitHub response.'); }
}

function requiredString(value: Record<string, unknown>, name: string): string {
  const result = value[name];
  if (typeof result !== 'string' || !result.trim()) throw new Error('Invalid GitHub response.');
  return result;
}

function positiveSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalTimestamp(data: Record<string, unknown>, name: string): number | undefined {
  const value = data[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid saved GitHub credentials.');
  }
  return value;
}

function parseCredential(value: unknown): CopilotCredential {
  const data = record(value);
  const clientId = requiredString(data, 'clientId');
  const accessToken = requiredString(data, 'accessToken');
  const refreshToken = data.refreshToken === undefined ? undefined : requiredString(data, 'refreshToken');
  const id = requiredString(data, 'id');
  const login = requiredString(data, 'login');
  const accessExpiresAt = optionalTimestamp(data, 'accessExpiresAt');
  const refreshExpiresAt = optionalTimestamp(data, 'refreshExpiresAt');
  return { clientId, accessToken, refreshToken, id, login,
    accessExpiresAt, refreshExpiresAt };
}

function validClientId(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(value);
}

function trustedDeviceUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && url.pathname === '/login/device' && !url.search && !url.hash;
  } catch { return false; }
}

function parseTokenResponse(data: Record<string, unknown>, clientId: string, now: number): Omit<CopilotCredential, keyof CopilotAccount> {
  const error = typeof data.error === 'string' ? data.error : undefined;
  if (error) {
    if (error === 'authorization_pending') throw new PendingAuthorization();
    if (error === 'slow_down') throw new SlowDownAuthorization(positiveSeconds(data.interval));
    if (error === 'expired_token' || error === 'token_expired') throw new Error('GitHub authorization expired. Start sign-in again.');
    if (error === 'access_denied') throw new Error('GitHub authorization was denied.');
    if (error === 'device_flow_disabled') throw new Error('Enable Device Flow in your GitHub OAuth App, then try again.');
    throw new Error('GitHub authorization could not be completed. Check your OAuth App Client ID and account access.');
  }

  const accessToken = requiredString(data, 'access_token');
  const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token.trim()
    ? data.refresh_token : undefined;
  const expiresIn = positiveSeconds(data.expires_in);
  const refreshExpiresIn = positiveSeconds(data.refresh_token_expires_in);
  return { clientId, accessToken, refreshToken,
    accessExpiresAt: expiresIn === undefined ? undefined : now + expiresIn * 1000,
    refreshExpiresAt: refreshExpiresIn === undefined ? undefined : now + refreshExpiresIn * 1000 };
}

class PendingAuthorization extends Error {}
class SlowDownAuthorization extends Error {
  constructor(readonly intervalSeconds?: number) { super(); }
}

export class CopilotAuth {
  private pending?: AbortController;
  private refreshPromise?: Promise<CopilotCredential>;
  private refreshController?: AbortController;
  private generation = 0;

  constructor(private readonly secrets: SecretStore, private readonly clientId: () => string,
    private readonly transport: Transport = requestUrl, private readonly clock: Clock = defaultClock) {}

  get account(): CopilotAccount | undefined {
    const credential = this.read();
    return credential ? { id: credential.id, login: credential.login } : undefined;
  }

  get connected(): boolean { return this.read() !== undefined; }

  private configuredClientId(): string {
    const value = this.clientId().trim();
    if (!validClientId(value)) throw new Error('Enter the Client ID from your GitHub OAuth App.');
    return value;
  }

  private read(): CopilotCredential | undefined {
    const raw = this.secrets.getSecret(SECRET_ID);
    if (!raw) return undefined;
    try {
      const credential = parseCredential(JSON.parse(raw));
      return credential.clientId === this.clientId().trim() ? credential : undefined;
    } catch { return undefined; }
  }

  private saveIfCurrent(credential: CopilotCredential, generation: number, expectedRefreshToken?: string): void {
    if (generation !== this.generation) throw new Error('GitHub authorization changed. Reconnect before retrying.');
    if (credential.clientId !== this.clientId().trim()) {
      throw new Error('GitHub OAuth App changed. Reconnect before retrying.');
    }
    if (expectedRefreshToken && this.read()?.refreshToken !== expectedRefreshToken) {
      throw new Error('GitHub authorization changed. Reconnect before retrying.');
    }
    this.secrets.setSecret(SECRET_ID, JSON.stringify(credential));
  }

  private invalidate(): void {
    this.generation += 1;
    this.refreshController?.abort();
    this.refreshController = undefined;
    this.refreshPromise = undefined;
  }

  signOut(): void {
    this.invalidate();
    this.pending?.abort();
    this.pending = undefined;
    this.secrets.setSecret(SECRET_ID, '');
  }

  cancelPending(): void {
    this.invalidate();
    this.pending?.abort();
    this.pending = undefined;
  }

  async startDeviceLogin(): Promise<CopilotDevicePrompt> {
    if (this.pending) throw new Error('GitHub authorization is already in progress.');
    const clientId = this.configuredClientId();
    this.invalidate();
    const generation = this.generation;
    const controller = new AbortController();
    this.pending = controller;

    try {
      const response = await this.untilCanceled(this.transport({
        url: DEVICE_CODE_URL,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ client_id: clientId }).toString(),
        throw: false,
      }), controller.signal);
      if (controller.signal.aborted || generation !== this.generation) throw new Error('GitHub authorization was canceled.');
      if (response.status < 200 || response.status >= 300) {
        throw new Error('GitHub Device Flow is unavailable. Check that it is enabled in your OAuth App.');
      }
      const data = parseJson(response.text);
      const deviceCode = requiredString(data, 'device_code');
      const userCode = requiredString(data, 'user_code');
      const interval = positiveSeconds(data.interval);
      const expiresIn = positiveSeconds(data.expires_in);
      if (!trustedDeviceUrl(data.verification_uri) || !interval || !expiresIn) {
        throw new Error('GitHub returned an invalid Device Flow response.');
      }
      const deadline = this.clock.now() + Math.min(expiresIn * 1000, LOGIN_TIMEOUT_MS);
      const complete = this.completeLogin(deviceCode, clientId, interval * 1000, deadline,
        generation, controller).finally(() => {
        if (this.pending === controller) this.pending = undefined;
      });
      return { userCode, verificationUrl: DEVICE_URL, complete, cancel: () => controller.abort() };
    } catch {
      if (this.pending === controller) this.pending = undefined;
      if (controller.signal.aborted || generation !== this.generation) {
        throw new Error('GitHub authorization was canceled.');
      }
      throw new Error('GitHub authorization could not start. Check your Client ID and Device Flow settings.');
    }
  }

  private async completeLogin(deviceCode: string, clientId: string, intervalMs: number, deadline: number,
    generation: number, controller: AbortController): Promise<void> {
    const token = await this.poll(deviceCode, clientId, intervalMs, deadline, generation, controller.signal);
    this.assertCurrent(generation, controller.signal);
    if (this.clock.now() >= deadline) throw new Error('GitHub authorization expired. Start sign-in again.');
    const account = await this.fetchAccount(token.accessToken, controller.signal);
    this.assertCurrent(generation, controller.signal);
    if (this.clock.now() >= deadline) throw new Error('GitHub authorization expired. Start sign-in again.');
    this.saveIfCurrent({ ...token, ...account }, generation);
  }

  private async poll(deviceCode: string, clientId: string, initialIntervalMs: number, deadline: number,
    generation: number, signal: AbortSignal): Promise<Omit<CopilotCredential, keyof CopilotAccount>> {
    let intervalMs = initialIntervalMs;
    while (this.clock.now() < deadline) {
      await this.clock.wait(Math.min(intervalMs, deadline - this.clock.now()), signal);
      this.assertCurrent(generation, signal);
      if (this.clock.now() >= deadline) break;
      let response;
      try {
        response = await this.untilCanceled(this.transport({
          url: ACCESS_TOKEN_URL,
          method: 'POST',
          contentType: 'application/x-www-form-urlencoded',
          headers: { Accept: 'application/json' },
          body: new URLSearchParams({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }).toString(),
          throw: false,
        }), signal);
      } catch {
        if (signal.aborted || generation !== this.generation) throw new Error('GitHub authorization was canceled.');
        throw new Error('Could not contact GitHub to complete authorization.');
      }
      this.assertCurrent(generation, signal);
      if (this.clock.now() >= deadline) break;

      let data: Record<string, unknown>;
      try { data = parseJson(response.text); }
      catch { throw new Error('GitHub returned an invalid authorization response.'); }
      try {
        if (response.status < 200 || response.status >= 300) {
          const error = typeof data.error === 'string' ? data.error : '';
          if (error === 'authorization_pending') throw new PendingAuthorization();
          if (error === 'slow_down') throw new SlowDownAuthorization(positiveSeconds(data.interval));
          parseTokenResponse(data, clientId, this.clock.now());
          throw new Error('GitHub authorization was rejected.');
        }
        return parseTokenResponse(data, clientId, this.clock.now());
      } catch (error) {
        if (signal.aborted || generation !== this.generation) {
          throw new Error('GitHub authorization was canceled.');
        }
        if (error instanceof PendingAuthorization) continue;
        if (error instanceof SlowDownAuthorization) {
          intervalMs = Math.max(intervalMs + 5000, (error.intervalSeconds ?? 0) * 1000);
          continue;
        }
        throw error;
      }
    }
    throw new Error('GitHub authorization expired. Start sign-in again.');
  }

  private assertCurrent(generation: number, signal?: AbortSignal): void {
    if (signal?.aborted || generation !== this.generation) {
      throw new Error('GitHub authorization was canceled.');
    }
  }

  private untilCanceled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error('GitHub authorization was canceled.'));
    return new Promise<T>((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new Error('GitHub authorization was canceled.')); };
      const cleanup = () => signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
  }

  private async fetchAccount(token: string, signal?: AbortSignal): Promise<CopilotAccount> {
    let response;
    try {
      const request = this.transport({
        url: ACCOUNT_URL,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Prism' },
        throw: false,
      });
      response = signal ? await this.untilCanceled(request, signal) : await request;
    } catch {
      if (signal?.aborted) throw new Error('GitHub authorization was canceled.');
      throw new CopilotAuthError('unavailable');
    }
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 429) throw new CopilotAuthError('rate_limit');
      if (response.status === 408 || response.status >= 500) throw new CopilotAuthError('unavailable');
      throw new CopilotAuthError('authentication');
    }
    let data: Record<string, unknown>;
    try { data = parseJson(response.text); }
    catch { throw new CopilotAuthError('authentication'); }
    const rawId = data.id;
    const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId)
      : typeof rawId === 'string' && /^\d+$/.test(rawId) ? rawId : undefined;
    const login = typeof data.login === 'string' && /^[A-Za-z0-9-]+$/.test(data.login) ? data.login : undefined;
    if (!id || !login) throw new CopilotAuthError('authentication');
    return { id, login };
  }

  async getAccessToken(): Promise<string> {
    const credential = this.read();
    if (!credential) throw new CopilotAuthError('authentication');
    if (credential.accessExpiresAt === undefined || credential.accessExpiresAt - this.clock.now() > REFRESH_SKEW_MS) {
      return credential.accessToken;
    }
    if (!credential.refreshToken ||
        (credential.refreshExpiresAt !== undefined && credential.refreshExpiresAt <= this.clock.now())) {
      throw new CopilotAuthError('authentication');
    }
    const refreshed = await this.refresh(credential);
    return refreshed.accessToken;
  }

  private refresh(credential: CopilotCredential): Promise<CopilotCredential> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const controller = new AbortController();
    this.refreshController = controller;
    const promise = this.refreshCredential(credential, generation, controller.signal).finally(() => {
      if (this.refreshPromise === promise) this.refreshPromise = undefined;
      if (this.refreshController === controller) this.refreshController = undefined;
    });
    this.refreshPromise = promise;
    return promise;
  }

  private async refreshCredential(credential: CopilotCredential, generation: number,
    signal: AbortSignal): Promise<CopilotCredential> {
    let response;
    try {
      response = await this.untilCanceled(this.transport({
        url: ACCESS_TOKEN_URL,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: credential.clientId,
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken ?? '',
        }).toString(),
        throw: false,
      }), signal);
    } catch {
      if (signal.aborted) throw new CopilotAuthError('authentication');
      throw new CopilotAuthError('unavailable');
    }
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 429) throw new CopilotAuthError('rate_limit');
      if (response.status === 408 || response.status >= 500) throw new CopilotAuthError('unavailable');
      throw new CopilotAuthError('authentication');
    }
    let data: Record<string, unknown>;
    try { data = parseJson(response.text); }
    catch { throw new CopilotAuthError('authentication'); }
    let token: Omit<CopilotCredential, keyof CopilotAccount>;
    try { token = parseTokenResponse(data, credential.clientId, this.clock.now()); }
    catch { throw new CopilotAuthError('authentication'); }
    const account = await this.fetchAccount(token.accessToken, signal);
    this.assertCurrent(generation, signal);
    if (account.id !== credential.id) throw new CopilotAuthError('authentication');
    const refreshed = { ...token, refreshToken: token.refreshToken ?? credential.refreshToken,
      refreshExpiresAt: token.refreshExpiresAt ?? credential.refreshExpiresAt, ...account };
    this.saveIfCurrent(refreshed, generation, credential.refreshToken);
    return refreshed;
  }
}
