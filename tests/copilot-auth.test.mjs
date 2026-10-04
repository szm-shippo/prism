import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const CLIENT_ID = 'Iv1.examplePublicClientId';
const CREDENTIAL_KEY = 'prism-copilot-credential';
const START_TIME = Date.UTC(2026, 0, 1);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/obsidian/copilot-auth.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false,
});

function response(status, body) {
  return { status, text: typeof body === 'string' ? body : JSON.stringify(body) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function settleBeforeNextTurn(promise) {
  return Promise.race([
    promise.then(() => ({ state: 'resolved' }), (error) => ({ state: 'rejected', error })),
    new Promise((resolve) => setImmediate(() => resolve({ state: 'pending' }))),
  ]);
}

function harness(handler, options = {}) {
  const secrets = new Map();
  const calls = [];
  const waits = [];
  let now = options.now ?? START_TIME;
  let configuredClientId = options.clientId ?? CLIENT_ID;
  const clock = {
    now: () => now,
    wait: async (milliseconds, signal) => {
      waits.push(milliseconds);
      if (signal.aborted) throw new Error('aborted');
      now += milliseconds;
    },
  };
  const transport = async (request) => {
    calls.push(request);
    return handler(request, calls);
  };
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: () => ({ requestUrl: transport }),
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
  });
  const secretStore = {
    getSecret: (id) => secrets.get(id) ?? null,
    setSecret: (id, value) => secrets.set(id, value),
  };
  const auth = new module.exports.CopilotAuth(secretStore, () => configuredClientId, transport, clock);
  return {
    auth, secrets, calls, waits,
    setClientId: (value) => { configuredClientId = value; },
    setNow: (value) => { now = value; },
    get now() { return now; },
  };
}

function form(request) {
  return new URLSearchParams(request.body);
}

function savedCredential(secrets) {
  return JSON.parse(secrets.get(CREDENTIAL_KEY));
}

test('device flow sends GitHub form fields, handles pending and slowdown, then verifies the account', async () => {
  let polls = 0;
  const { auth, calls, waits, secrets } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) {
      return response(200, { device_code: 'device-code-example', user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 3600 });
    }
    if (request.url.endsWith('/login/oauth/access_token')) {
      polls += 1;
      if (polls === 1) return response(400, { error: 'authorization_pending' });
      if (polls === 2) return response(400, { error: 'slow_down', interval: 7 });
      return response(200, { access_token: 'gho_example_access', refresh_token: 'ghr_example_refresh',
        expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    return response(200, { id: 42, login: 'prism-user' });
  });

  const prompt = await auth.startDeviceLogin();
  assert.equal(prompt.userCode, 'ABCD-EFGH');
  assert.equal(prompt.verificationUrl, 'https://github.com/login/device');
  await prompt.complete;

  const deviceRequest = calls.find((call) => call.url.endsWith('/login/device/code'));
  assert.equal(deviceRequest.method, 'POST');
  assert.equal(deviceRequest.contentType, 'application/x-www-form-urlencoded');
  assert.equal(deviceRequest.headers.Accept, 'application/json');
  assert.deepEqual([...form(deviceRequest).keys()], ['client_id']);
  assert.equal(form(deviceRequest).get('client_id'), CLIENT_ID);

  const tokenCalls = calls.filter((call) => call.url.endsWith('/login/oauth/access_token'));
  assert.equal(tokenCalls.length, 3);
  for (const call of tokenCalls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.contentType, 'application/x-www-form-urlencoded');
    assert.equal(call.headers.Accept, 'application/json');
    assert.deepEqual([...form(call).keys()], ['client_id', 'device_code', 'grant_type']);
    assert.equal(form(call).get('client_id'), CLIENT_ID);
    assert.equal(form(call).get('device_code'), 'device-code-example');
    assert.equal(form(call).get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  }
  assert.deepEqual(waits, [1000, 1000, 7000]);

  const accountCall = calls.find((call) => call.url === 'https://api.github.com/user');
  assert.equal(accountCall.method, 'GET');
  assert.equal(accountCall.headers.Authorization, 'Bearer gho_example_access');
  assert.equal(accountCall.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.deepEqual({ ...auth.account }, { id: '42', login: 'prism-user' });
  assert.equal(savedCredential(secrets).accessToken, 'gho_example_access');
});

test('device flow refuses an untrusted verification URL and hides response details', async () => {
  const marker = 'untrusted-response-detail';
  for (const verificationUrl of [
    'https://github.com.evil.example/login/device',
    'https://github.com/login/device?redirect_uri=https://attacker.example',
  ]) {
    const { auth, calls, secrets } = harness(() => response(200, {
      device_code: 'device-code-example', user_code: 'ABCD-EFGH',
      verification_uri: verificationUrl, interval: 1, expires_in: 600, debug: marker,
    }));

    await assert.rejects(auth.startDeviceLogin(), (error) => {
      assert.match(error.message, /could not start/i);
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(auth.connected, false);
    assert.equal(secrets.has(CREDENTIAL_KEY), false);
  }
});

test('authorization denial returns a fixed safe error and stores no token', async () => {
  const marker = 'private-github-response-detail';
  const { auth, calls, secrets } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) return response(200, {
      device_code: 'device-code-example', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 600,
    });
    return response(400, { error: 'access_denied', error_description: marker });
  });

  const prompt = await auth.startDeviceLogin();
  await assert.rejects(prompt.complete, (error) => {
    assert.equal(error.message, 'GitHub authorization was denied.');
    assert.doesNotMatch(error.message, /private-github-response-detail|device-code-example/);
    return true;
  });
  assert.equal(calls.filter((call) => call.url.endsWith('/login/oauth/access_token')).length, 1);
  assert.equal(auth.connected, false);
  assert.equal(secrets.has(CREDENTIAL_KEY), false);
});

test('long-lived access tokens restore from SecretStorage and remain usable without refresh metadata', async () => {
  const { auth, secrets, calls, now } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) return response(200, {
      device_code: 'device-code-example', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 600,
    });
    if (request.url.endsWith('/login/oauth/access_token')) return response(200, {
      access_token: 'gho_long_lived_example',
    });
    return response(200, { id: 73, login: 'long-lived-user' });
  });
  const providerSecret = JSON.stringify({ accessToken: 'unrelated-provider-secret' });
  secrets.set('prism-codex-credential', providerSecret);

  const prompt = await auth.startDeviceLogin();
  await prompt.complete;
  const saved = savedCredential(secrets);
  assert.equal(saved.accessToken, 'gho_long_lived_example');
  assert.equal(saved.clientId, CLIENT_ID);
  assert.equal(saved.id, '73');
  assert.equal(saved.login, 'long-lived-user');
  assert.equal(Object.hasOwn(saved, 'refreshToken'), false);
  assert.equal(Object.hasOwn(saved, 'accessExpiresAt'), false);
  assert.equal(Object.hasOwn(saved, 'refreshExpiresAt'), false);
  assert.equal(secrets.get('prism-codex-credential'), providerSecret);

  const restored = harness(() => { throw new Error('a long-lived token should not require network refresh'); }, { now });
  for (const [key, value] of secrets) restored.secrets.set(key, value);
  assert.equal(restored.auth.connected, true);
  assert.equal(await restored.auth.getAccessToken(), 'gho_long_lived_example');
  assert.deepEqual({ ...restored.auth.account }, { id: '73', login: 'long-lived-user' });
  assert.equal(restored.calls.length, 0);

  auth.signOut();
  assert.equal(auth.connected, false);
  assert.equal(secrets.get(CREDENTIAL_KEY), '');
  assert.equal(secrets.get('prism-codex-credential'), providerSecret);
  assert.equal(calls.some((call) => call.url.includes('access_token') && form(call).has('client_secret')), false);
});

test('expired credentials refresh once for concurrent callers and persist rotated tokens', async () => {
  const refreshResponse = deferred();
  const refreshStarted = deferred();
  const { auth, secrets, calls, now } = harness((request) => {
    if (request.url.endsWith('/login/oauth/access_token')) {
      refreshStarted.resolve();
      return refreshResponse.promise;
    }
    return response(200, { id: 81, login: 'refresh-user' });
  });
  secrets.set(CREDENTIAL_KEY, JSON.stringify({ clientId: CLIENT_ID, accessToken: 'gho_old_access',
    refreshToken: 'ghr_old_refresh', accessExpiresAt: now - 1, refreshExpiresAt: now + 86_400_000,
    id: '81', login: 'refresh-user' }));

  const first = auth.getAccessToken();
  const second = auth.getAccessToken();
  await refreshStarted.promise;
  const refreshCalls = calls.filter((call) => call.url.endsWith('/login/oauth/access_token'));
  assert.equal(refreshCalls.length, 1);
  const fields = form(refreshCalls[0]);
  assert.equal(fields.get('client_id'), CLIENT_ID);
  assert.equal(fields.get('grant_type'), 'refresh_token');
  assert.equal(fields.get('refresh_token'), 'ghr_old_refresh');
  refreshResponse.resolve(response(200, { access_token: 'gho_rotated_access', refresh_token: 'ghr_rotated_refresh',
    expires_in: 7200, refresh_token_expires_in: 172800 }));

  assert.deepEqual(await Promise.all([first, second]), ['gho_rotated_access', 'gho_rotated_access']);
  const saved = savedCredential(secrets);
  assert.equal(saved.accessToken, 'gho_rotated_access');
  assert.equal(saved.refreshToken, 'ghr_rotated_refresh');
  assert.equal(saved.accessExpiresAt, now + 7200_000);
  assert.equal(saved.refreshExpiresAt, now + 172800_000);
  assert.equal(calls.filter((call) => call.url === 'https://api.github.com/user').length, 1);
});

test('refresh rejects an account switch and an expired credential without a usable refresh token', async () => {
  const { auth, secrets, calls, now } = harness((request) => {
    if (request.url.endsWith('/login/oauth/access_token')) return response(200, {
      access_token: 'gho_other_account', refresh_token: 'ghr_rotated', expires_in: 3600,
    });
    return response(200, { id: 92, login: 'different-user' });
  });
  const original = { clientId: CLIENT_ID, accessToken: 'gho_existing', refreshToken: 'ghr_existing',
    accessExpiresAt: now - 1, refreshExpiresAt: now + 86_400_000, id: '91', login: 'original-user' };
  secrets.set(CREDENTIAL_KEY, JSON.stringify(original));

  await assert.rejects(auth.getAccessToken(), (error) => error.code === 'authentication');
  assert.deepEqual(savedCredential(secrets), original);
  assert.deepEqual({ ...auth.account }, { id: '91', login: 'original-user' });

  secrets.set(CREDENTIAL_KEY, JSON.stringify({ ...original, accessExpiresAt: now - 1,
    refreshExpiresAt: now - 1 }));
  calls.length = 0;
  await assert.rejects(auth.getAccessToken(), /sign in again/i);
  assert.equal(calls.length, 0);
  secrets.set(CREDENTIAL_KEY, JSON.stringify({ clientId: CLIENT_ID, accessToken: 'gho_expired_no_refresh',
    accessExpiresAt: now - 1, id: '91', login: 'original-user' }));
  await assert.rejects(auth.getAccessToken(), /sign in again/i);
  assert.equal(calls.length, 0);
});

test('a token response arriving at the device-flow deadline cannot complete sign-in', async () => {
  const pollResponse = deferred();
  const pollStarted = deferred();
  const { auth, calls, secrets, setNow } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) return response(200, {
      device_code: 'device-code-example', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 5,
    });
    if (request.url.endsWith('/login/oauth/access_token')) {
      pollStarted.resolve();
      return pollResponse.promise;
    }
    return response(200, { id: 99, login: 'too-late-user' });
  });
  const prompt = await auth.startDeviceLogin();
  const completion = prompt.complete;
  await pollStarted.promise;
  setNow(START_TIME + 5000);
  pollResponse.resolve(response(200, { access_token: 'gho_too_late' }));

  await assert.rejects(completion, /authorization expired/i);
  assert.equal(calls.some((call) => call.url === 'https://api.github.com/user'), false);
  assert.equal(auth.connected, false);
  assert.equal(secrets.has(CREDENTIAL_KEY), false);
});

test('cancel settles an unabortable device poll promptly and ignores its late response', async () => {
  const pollResponse = deferred();
  const pollStarted = deferred();
  const { auth, calls, secrets } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) return response(200, {
      device_code: 'device-code-example', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 600,
    });
    if (request.url.endsWith('/login/oauth/access_token')) {
      pollStarted.resolve();
      return pollResponse.promise;
    }
    return response(200, { id: 101, login: 'late-user' });
  });
  const prompt = await auth.startDeviceLogin();
  const completion = prompt.complete;
  await pollStarted.promise;
  prompt.cancel();

  const outcome = await settleBeforeNextTurn(completion);
  assert.equal(outcome.state, 'rejected', 'cancel should settle before the unabortable request responds');
  assert.match(outcome.error.message, /canceled/i);
  assert.doesNotMatch(outcome.error.message, /device-code-example|gho_late_token/);
  pollResponse.resolve(response(200, { access_token: 'gho_late_token' }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.some((call) => call.url === 'https://api.github.com/user'), false);
  assert.equal(auth.connected, false);
  assert.equal(secrets.has(CREDENTIAL_KEY), false);
});

test('sign-out during account verification prevents a late profile response from saving credentials', async () => {
  const accountResponse = deferred();
  const accountStarted = deferred();
  const { auth, calls, secrets } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) return response(200, {
      device_code: 'device-code-example', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 600,
    });
    if (request.url.endsWith('/login/oauth/access_token')) return response(200, { access_token: 'gho_late_token' });
    accountStarted.resolve();
    return accountResponse.promise;
  });
  const prompt = await auth.startDeviceLogin();
  const completion = prompt.complete;
  await accountStarted.promise;
  auth.signOut();

  await assert.rejects(completion, /canceled/i);
  accountResponse.resolve(response(200, { id: 111, login: 'late-user' }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(auth.connected, false);
  assert.equal(secrets.get(CREDENTIAL_KEY), '');
  assert.equal(savedCredentialAfterSignOut(secrets), undefined);
  assert.equal(calls.filter((call) => call.url === 'https://api.github.com/user').length, 1);
});

function savedCredentialAfterSignOut(secrets) {
  const raw = secrets.get(CREDENTIAL_KEY);
  return raw ? JSON.parse(raw) : undefined;
}

test('sign-out and reconnect keep a late old device response from replacing the new account', async () => {
  const oldPollResponse = deferred();
  const oldPollStarted = deferred();
  let loginNumber = 0;
  const { auth, secrets } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) {
      loginNumber += 1;
      return response(200, { device_code: `device-${loginNumber}`, user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 600 });
    }
    if (request.url.endsWith('/login/oauth/access_token')) {
      if (form(request).get('device_code') === 'device-1') {
        oldPollStarted.resolve();
        return oldPollResponse.promise;
      }
      return response(200, { access_token: 'gho_new_account' });
    }
    return response(200, { id: 222, login: 'new-account' });
  });
  const oldPrompt = await auth.startDeviceLogin();
  const oldCompletion = oldPrompt.complete;
  await oldPollStarted.promise;
  auth.signOut();
  const oldOutcome = await settleBeforeNextTurn(oldCompletion);
  assert.equal(oldOutcome.state, 'rejected', 'sign-out should settle the old login before its request responds');
  assert.match(oldOutcome.error.message, /canceled/i);

  const newPrompt = await auth.startDeviceLogin();
  await newPrompt.complete;
  assert.deepEqual({ ...auth.account }, { id: '222', login: 'new-account' });
  oldPollResponse.resolve(response(200, { access_token: 'gho_old_account' }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual({ ...auth.account }, { id: '222', login: 'new-account' });
  assert.equal(savedCredential(secrets).accessToken, 'gho_new_account');
});

test('changing the Client ID during profile verification prevents old-client credentials from being restored', async () => {
  const accountResponse = deferred();
  const accountStarted = deferred();
  const { auth, secrets, setClientId } = harness((request) => {
    if (request.url.endsWith('/login/device/code')) return response(200, {
      device_code: 'device-code-example', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 600,
    });
    if (request.url.endsWith('/login/oauth/access_token')) return response(200, { access_token: 'gho_old_client' });
    accountStarted.resolve();
    return accountResponse.promise;
  });
  const prompt = await auth.startDeviceLogin();
  const completion = prompt.complete;
  await accountStarted.promise;
  setClientId('Iv1.changedClientId');
  accountResponse.resolve(response(200, { id: 333, login: 'old-client-user' }));

  await assert.rejects(completion, /changed|reconnect/i);
  assert.equal(auth.connected, false);
  assert.equal(savedCredentialAfterSignOut(secrets), undefined);
  setClientId(CLIENT_ID);
  assert.equal(auth.connected, false);
});
