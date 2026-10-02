import { requestUrl, type RequestUrlParam } from 'obsidian';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ORIGIN = 'https://auth.openai.com';
const TOKEN_URL = `${AUTH_ORIGIN}/oauth/token`;
const SECRET_ID = 'prism-codex-credential';
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;
// The catalog filters by Codex client version; Prism's plugin version is unrelated.
const CODEX_CATALOG_CLIENT_VERSION = '0.155.0';

type Transport = typeof requestUrl;
type SecretStore = { getSecret(id: string): string | null; setSecret(id: string, value: string): void };

export interface CodexCredential {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
  idToken?: string;
  subject?: string;
}

export interface DevicePrompt {
  userCode: string;
  verificationUrl: string;
  complete: Promise<void>;
  cancel(): void;
}

export class CodexModelListError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid authentication response.');
  return value as Record<string, unknown>;
}

function required(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== 'string' || !field) throw new Error('Invalid authentication response.');
  return field;
}

function parseJson(text: string): Record<string, unknown> {
  try { return record(JSON.parse(text)); } catch { throw new Error('Invalid authentication response.'); }
}

function decodePart(part: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid identity token.');
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) => character.charCodeAt(0));
  } catch { throw new Error('Invalid identity token.'); }
}

function decodeClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid identity token.');
  try {
    return record(JSON.parse(new TextDecoder().decode(decodePart(parts[1]))));
  } catch { throw new Error('Invalid identity token.'); }
}

function accountIdFromToken(token: string): string | undefined {
  const claims = decodeClaims(token);
  const auth = claims['https://api.openai.com/auth'];
  const nested = auth && typeof auth === 'object' && !Array.isArray(auth)
    ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  const accountId = claims.chatgpt_account_id ?? nested;
  return typeof accountId === 'string' && accountId ? accountId : undefined;
}

function parseCredential(value: unknown): CodexCredential {
  const data = record(value);
  const accessToken = required(data, 'accessToken');
  const refreshToken = required(data, 'refreshToken');
  const accountId = required(data, 'accountId');
  if (typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) throw new Error('Invalid saved credentials.');
  if (data.idToken !== undefined && (typeof data.idToken !== 'string' || !data.idToken)) throw new Error('Invalid saved credentials.');
  if (data.subject !== undefined && (typeof data.subject !== 'string' || !data.subject)) throw new Error('Invalid saved credentials.');
  return { accessToken, refreshToken, accountId, expiresAt: data.expiresAt,
    ...(typeof data.idToken === 'string' ? { idToken: data.idToken } : {}),
    ...(typeof data.subject === 'string' ? { subject: data.subject } : {}) };
}

function parseTokenResponse(text: string, previousAccountId?: string): CodexCredential {
  const data = parseJson(text);
  const accessToken = required(data, 'access_token');
  const refreshToken = required(data, 'refresh_token');
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new Error('Invalid authentication response.');
  }
  const idToken = typeof data.id_token === 'string' && data.id_token ? data.id_token : undefined;
  const accessAccount = accountIdFromToken(accessToken);
  const idAccount = idToken ? accountIdFromToken(idToken) : undefined;
  if (!accessAccount && !idAccount) throw new Error('Authentication response has no account identity.');
  if (idAccount && accessAccount && idAccount !== accessAccount) throw new Error('Authentication returned conflicting accounts.');
  const accountId = accessAccount ?? idAccount!;
  if (previousAccountId && accountId !== previousAccountId) throw new Error('Authentication changed accounts.');
  return { accessToken, refreshToken, accountId,
    expiresAt: Date.now() + data.expires_in * 1000, ...(idToken ? { idToken } : {}) };
}

async function verifyIdToken(idToken: string, transport: Transport): Promise<string> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid identity token.');
  let header: Record<string, unknown>;
  try { header = record(JSON.parse(new TextDecoder().decode(decodePart(parts[0])))); }
  catch { throw new Error('Invalid identity token.'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported identity token.');
  const claims = decodeClaims(idToken);
  if (claims.iss !== AUTH_ORIGIN ||
      !(claims.aud === CLIENT_ID || Array.isArray(claims.aud) && claims.aud.includes(CLIENT_ID)) ||
      typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000 ||
      typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('Invalid identity token.');
  }
  let jwks;
  try { jwks = await transport({ url: `${AUTH_ORIGIN}/.well-known/jwks.json`, throw: false }); }
  catch { throw new Error('OpenAI identity verification is unavailable.'); }
  if (jwks.status !== 200) throw new Error('OpenAI identity verification is unavailable.');
  const keys = parseJson(jwks.text).keys;
  if (!Array.isArray(keys)) throw new Error('Invalid OpenAI identity keys.');
  const key = keys.find((item) => item && typeof item === 'object' &&
    (item as Record<string, unknown>).kid === header.kid && (item as Record<string, unknown>).kty === 'RSA');
  if (!key) throw new Error('Unknown OpenAI identity key.');
  try {
    const publicKey = await crypto.subtle.importKey('jwk', key as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey,
      new Uint8Array([...decodePart(parts[2])]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error();
  } catch { throw new Error('Invalid identity token signature.'); }
  return claims.sub;
}

async function formRequest(transport: Transport, body: URLSearchParams): Promise<string> {
  let response;
  try {
    response = await transport({ url: TOKEN_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded',
      body: body.toString(), throw: false });
  } catch { throw new Error('OpenAI authentication is unavailable.'); }
  if (response.status < 200 || response.status >= 300) throw new Error('OpenAI authentication was rejected.');
  return response.text;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Authentication canceled.')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(new Error('Authentication canceled.')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export class CodexAuth {
  private pending?: AbortController;
  private refreshPromise?: Promise<CodexCredential>;
  private generation = 0;
  private models?: string[];

  constructor(private readonly secrets: SecretStore, private readonly transport: Transport = requestUrl) {}

  get accountId(): string | undefined { return this.read()?.accountId; }
  get connected(): boolean { return this.read() !== undefined; }
  get availableModels(): readonly string[] { return this.models ?? []; }

  private read(): CodexCredential | undefined {
    const raw = this.secrets.getSecret(SECRET_ID);
    if (!raw) return undefined;
    try { return parseCredential(JSON.parse(raw)); } catch { return undefined; }
  }

  private save(credential: CodexCredential): void {
    this.secrets.setSecret(SECRET_ID, JSON.stringify(credential));
  }

  signOut(): void {
    this.pending?.abort();
    this.pending = undefined;
    this.generation += 1;
    this.models = undefined;
    this.secrets.setSecret(SECRET_ID, '');
  }

  cancelPending(): void {
    this.pending?.abort();
    this.pending = undefined;
  }

  async startDeviceLogin(): Promise<DevicePrompt> {
    if (this.pending) throw new Error('Authentication is already in progress.');
    const controller = new AbortController();
    this.pending = controller;
    const generation = this.generation;
    let response;
    try {
      response = await this.transport({ url: `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`, method: 'POST',
        contentType: 'application/json', body: JSON.stringify({ client_id: CLIENT_ID }), throw: false });
      if (controller.signal.aborted) throw new Error('Authentication canceled.');
      if (response.status < 200 || response.status >= 300) throw new Error('Device authorization is unavailable.');
      const data = parseJson(response.text);
      const deviceAuthId = required(data, 'device_auth_id');
      const userCode = required(data, 'user_code');
      const seconds = Number(data.interval);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid authentication response.');
      const complete = this.poll(deviceAuthId, userCode, Math.max(seconds * 1000, 1000), controller.signal)
        .then((credential) => {
          if (controller.signal.aborted || generation !== this.generation) throw new Error('Authentication canceled.');
          this.generation += 1;
          this.save(credential);
          this.models = undefined;
        }).finally(() => { if (this.pending === controller) this.pending = undefined; });
      return { userCode, verificationUrl: `${AUTH_ORIGIN}/codex/device`, complete,
        cancel: () => controller.abort() };
    } catch {
      if (this.pending === controller) this.pending = undefined;
      throw new Error('Device authorization could not start.');
    }
  }

  private async poll(deviceAuthId: string, userCode: string, interval: number, signal: AbortSignal): Promise<CodexCredential> {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await wait(Math.min(interval, deadline - Date.now()), signal);
      if (signal.aborted) throw new Error('Authentication canceled.');
      let response;
      try {
        response = await this.transport({ url: `${AUTH_ORIGIN}/api/accounts/deviceauth/token`, method: 'POST',
          contentType: 'application/json', body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
          throw: false });
      } catch { throw new Error('OpenAI authentication is unavailable.'); }
      if (response.status === 403 || response.status === 404) continue;
      if (response.status < 200 || response.status >= 300) throw new Error('Device authorization was rejected.');
      const data = parseJson(response.text);
      const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID,
        code: required(data, 'authorization_code'), code_verifier: required(data, 'code_verifier'),
        redirect_uri: `${AUTH_ORIGIN}/deviceauth/callback` });
      const credential = parseTokenResponse(await formRequest(this.transport, body));
      if (credential.idToken) credential.subject = await verifyIdToken(credential.idToken, this.transport);
      if (signal.aborted) throw new Error('Authentication canceled.');
      return credential;
    }
    throw new Error('Device authorization expired.');
  }

  async access(): Promise<{ token: string; accountId: string }> {
    const credential = this.read();
    if (!credential) throw new Error('Connect a ChatGPT account in Prism settings.');
    const current = credential.expiresAt - Date.now() > REFRESH_SKEW_MS ? credential : await this.refresh(credential);
    return { token: current.accessToken, accountId: current.accountId };
  }

  async refreshAfterUnauthorized(token: string): Promise<{ token: string; accountId: string }> {
    const credential = this.read();
    if (!credential) throw new Error('Connect a ChatGPT account in Prism settings.');
    const current = credential.accessToken === token ? await this.refresh(credential) : credential;
    return { token: current.accessToken, accountId: current.accountId };
  }

  async listModels(force = false): Promise<string[]> {
    if (this.models && !force) return this.models;
    const access = await this.access();
    const query = async (token: string, accountId: string) => {
      try {
        return await this.transport({ url: `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`,
          method: 'GET', headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId,
            originator: 'prism' }, throw: false });
      } catch { throw new CodexModelListError('Could not load Codex models: connection failed.'); }
    };
    let response = await query(access.token, access.accountId);
    if (response.status === 401) {
      const renewed = await this.refreshAfterUnauthorized(access.token);
      response = await query(renewed.token, renewed.accountId);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CodexModelListError(`Could not load Codex models: ChatGPT returned HTTP ${response.status}.`);
    }
    let models: unknown;
    try { models = parseJson(response.text).models; }
    catch { throw new CodexModelListError('Could not load Codex models: invalid response.'); }
    if (!Array.isArray(models)) throw new CodexModelListError('Could not load Codex models: invalid response.');
    const available = models.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      .filter((item) => item.visibility === 'list')
      .map((item) => item.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
    if (available.length === 0) throw new CodexModelListError('Could not load Codex models: no listed models.');
    this.models = available;
    return available;
  }

  private refresh(credential: CodexCredential): Promise<CodexCredential> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID,
      refresh_token: credential.refreshToken });
    const promise = formRequest(this.transport, body).then(async (text) => {
      const next = parseTokenResponse(text, credential.accountId);
      if (next.idToken) {
        next.subject = await verifyIdToken(next.idToken, this.transport);
        if (credential.subject && next.subject !== credential.subject) throw new Error('Authentication changed accounts.');
      } else if (credential.subject) {
        next.subject = credential.subject;
        next.idToken = credential.idToken;
      }
      const stored = this.read();
      if (generation !== this.generation || !stored ||
          stored.accessToken !== credential.accessToken || stored.refreshToken !== credential.refreshToken) {
        throw new Error('Authentication changed during refresh.');
      }
      this.save(next);
      return next;
    }).finally(() => { if (this.refreshPromise === promise) this.refreshPromise = undefined; });
    this.refreshPromise = promise;
    return promise;
  }
}
