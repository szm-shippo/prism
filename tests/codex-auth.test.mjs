import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/codex-auth.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false,
});

const keyPair = await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const publicJwk = { ...await webcrypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'test-key' };
async function signedToken(accountId) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: accountId,
    iss: 'https://auth.openai.com', aud: 'app_EMoamEEZ73f0CkXaXp7hrann',
    exp: Math.floor(Date.now() / 1000) + 3600, sub: `subject-${accountId}` })).toString('base64url');
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
}
const tokens = { 'account-1': await signedToken('account-1'), 'account-2': await signedToken('account-2') };
function token(accountId) { return tokens[accountId]; }

function tokenResponse(accountId, refreshToken = 'refresh-1') {
  return { status: 200, text: JSON.stringify({ access_token: token(accountId),
    refresh_token: refreshToken, id_token: token(accountId), expires_in: 3600 }) };
}

function harness(handler) {
  const secrets = new Map();
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    if (request.url.endsWith('/.well-known/jwks.json')) {
      return { status: 200, text: JSON.stringify({ keys: [publicJwk] }) };
    }
    return handler(request);
  };
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: () => ({ requestUrl: transport }),
    URLSearchParams, Date, JSON, Number, TextDecoder, TextEncoder, Uint8Array, atob, crypto: webcrypto,
    AbortController, setTimeout, clearTimeout,
  });
  const store = { getSecret: (id) => secrets.get(id) ?? null,
    setSecret: (id, value) => secrets.set(id, value) };
  return { auth: new module.exports.CodexAuth(store, transport), secrets, calls };
}

test('device login waits for approval and stores only the authorized account in SecretStorage', async () => {
  let polls = 0;
  const { auth, secrets, calls } = harness((request) => {
    if (request.url.endsWith('/deviceauth/usercode')) return { status: 200,
      text: JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD', interval: 0.001 }) };
    if (request.url.endsWith('/deviceauth/token')) {
      polls += 1;
      return polls === 1 ? { status: 403, text: '' } : { status: 200,
        text: JSON.stringify({ authorization_code: 'code-1', code_verifier: 'verifier-1' }) };
    }
    return tokenResponse('account-1');
  });
  const prompt = await auth.startDeviceLogin();
  assert.equal(prompt.userCode, 'ABCD');
  assert.equal(prompt.verificationUrl, 'https://auth.openai.com/codex/device');
  await prompt.complete;
  assert.equal(auth.accountId, 'account-1');
  assert.equal(secrets.size, 1);
  assert.match([...secrets.values()][0], /refresh-1/);
  assert.equal(new URLSearchParams(calls.find((call) => call.url.endsWith('/oauth/token')).body)
    .get('code_verifier'), 'verifier-1');
});

test('canceling device login cannot save late credentials', async () => {
  const { auth, secrets } = harness((request) => request.url.endsWith('/deviceauth/usercode')
    ? { status: 200, text: JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD', interval: 0.001 }) }
    : tokenResponse('account-1'));
  const prompt = await auth.startDeviceLogin();
  prompt.cancel();
  await assert.rejects(prompt.complete, /canceled/);
  assert.equal(auth.connected, false);
  assert.equal(secrets.size, 0);
});

test('device login rejects a token with an invalid identity signature', async () => {
  const valid = token('account-1');
  const [header, payload, signature] = valid.split('.');
  const invalid = `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  const { auth, secrets } = harness((request) => {
    if (request.url.endsWith('/deviceauth/usercode')) return { status: 200,
      text: JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD', interval: 0.001 }) };
    if (request.url.endsWith('/deviceauth/token')) return { status: 200,
      text: JSON.stringify({ authorization_code: 'code-1', code_verifier: 'verifier-1' }) };
    return { status: 200, text: JSON.stringify({ access_token: token('account-1'),
      refresh_token: 'refresh-1', id_token: invalid, expires_in: 3600 }) };
  });
  const prompt = await auth.startDeviceLogin();
  await assert.rejects(prompt.complete, /signature/);
  assert.equal(secrets.size, 0);
});

test('device login accepts a token response without an optional ID token', async () => {
  const { auth, secrets } = harness((request) => {
    if (request.url.endsWith('/deviceauth/usercode')) return { status: 200,
      text: JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD', interval: 0.001 }) };
    if (request.url.endsWith('/deviceauth/token')) return { status: 200,
      text: JSON.stringify({ authorization_code: 'code-1', code_verifier: 'verifier-1' }) };
    return { status: 200, text: JSON.stringify({ access_token: token('account-1'),
      refresh_token: 'refresh-1', expires_in: 3600 }) };
  });
  const prompt = await auth.startDeviceLogin();
  await prompt.complete;
  assert.equal(auth.accountId, 'account-1');
  assert.doesNotMatch(secrets.get('prism-codex-credential'), /idToken/);
});

test('refresh rotates the saved token and rejects an account switch', async () => {
  let refreshAccount = 'account-1';
  const { auth, secrets } = harness(() => tokenResponse(refreshAccount, 'refresh-2'));
  secrets.set('prism-codex-credential', JSON.stringify({ accessToken: token('account-1'),
    refreshToken: 'refresh-1', accountId: 'account-1', expiresAt: 0 }));
  const access = await auth.access();
  assert.equal(access.accountId, 'account-1');
  assert.match(secrets.get('prism-codex-credential'), /refresh-2/);
  secrets.set('prism-codex-credential', JSON.stringify({ accessToken: token('account-1'),
    refreshToken: 'refresh-2', accountId: 'account-1', expiresAt: 0 }));
  refreshAccount = 'account-2';
  await assert.rejects(auth.access(), /changed accounts/);
  assert.equal(auth.accountId, 'account-1');
  auth.signOut();
  assert.equal(auth.connected, false);
});

test('model catalog includes only models the authorized account can select', async () => {
  const { auth, secrets, calls } = harness(() => ({ status: 200,
    text: JSON.stringify({ models: [
      { slug: 'available-model', visibility: 'list', supported_in_api: true },
      { slug: 'hidden-model', visibility: 'hide', supported_in_api: true },
      { slug: 'unsupported-model', visibility: 'list', supported_in_api: false },
    ] }) }));
  secrets.set('prism-codex-credential', JSON.stringify({ accessToken: token('account-1'),
    refreshToken: 'refresh-1', accountId: 'account-1', expiresAt: Date.now() + 3600_000 }));
  assert.deepEqual(structuredClone(await auth.listModels()), ['available-model']);
  assert.equal(calls[0].headers['ChatGPT-Account-Id'], 'account-1');
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.1.0');
});
