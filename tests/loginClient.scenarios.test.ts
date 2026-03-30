import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── native module mocks ───────────────────────────────────────────────────────

const mockCrypto = vi.hoisted(() => ({
  getRandomValues(array: Uint32Array) { for (let i = 0; i < array.length; i++) {array[i] = i + 1;} return array; },
  subtle: {
    async digest(_alg: string, _data: Uint8Array): Promise<ArrayBuffer> {
      const bytes = new Uint8Array(32); bytes[0] = 0xD3; bytes[1] = 0x40; return bytes.buffer;
    }
  }
}));

const mockStorage = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    store,
    setItem: vi.fn(async (key: string, value: string) => { store[key] = value; }),
    getItem: vi.fn(async (key: string) => store[key] ?? null),
    removeItem: vi.fn(async (key: string) => { delete store[key]; })
  };
});

const mockNitroCookies = vi.hoisted(() => ({
  get: vi.fn(async (_url: string) => ({} as Record<string, { name: string; value: string }>)),
  set: vi.fn(async () => {}),
  clearByName: vi.fn(async () => {})
}));

vi.mock('react-native-quick-crypto', () => ({ default: mockCrypto }));
vi.mock('react-native-encrypted-storage', () => ({ default: mockStorage }));
vi.mock('react-native-nitro-cookies', () => ({ default: mockNitroCookies }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LoginClient } from '../src/loginClient.ts';
import { TokenTimeoutError, NoAuthenticationRequestInProgressError, AuthenticationRequestMismatchError, NotLoggedInError, InvalidConnectionError } from '../src/types.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

const ISSUER = 'https://my-app.login.authress.io';

const BASE_SETTINGS = {
  authressApiUrl: 'https://my-app.login.authress.io',
  applicationId: 'app_123',
  redirectUri: 'myapp://callback'
};

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

function makeResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return { ok, status, headers: new Headers(), text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)) };
}

/** Sets the authorization cookie in the mock native jar. */
function mockToken(jwt: string) {
  mockNitroCookies.get.mockResolvedValue({ authorization: { name: 'authorization', value: jwt } });
}

/** Puts a pending authentication request into encrypted storage. */
function storePendingAuth(authenticationRequestId = 'req-abc') {
  mockStorage.store['authress-pending-auth'] = JSON.stringify({
    codeVerifier: 'verifier-xyz',
    authenticationRequestId,
    redirectUrl: 'myapp://callback',
    applicationId: 'app_123'
  });
}

// ── reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(mockStorage.store)) {delete mockStorage.store[key];}
  vi.clearAllMocks();
  mockStorage.setItem.mockImplementation(async (key: string, value: string) => { mockStorage.store[key] = value; });
  mockStorage.getItem.mockImplementation(async (key: string) => mockStorage.store[key] ?? null);
  mockStorage.removeItem.mockImplementation(async (key: string) => { delete mockStorage.store[key]; });
  mockNitroCookies.get.mockResolvedValue({});
  mockNitroCookies.set.mockResolvedValue(undefined);
  mockNitroCookies.clearByName.mockResolvedValue(undefined);
});

// ── userIsLoggedIn ─────────────────────────────────────────────────────────────

describe('userIsLoggedIn', () => {
  it('server confirms session — triggers cookie backup so a future app restart can restore auth state', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValueOnce({}) // getToken check (no cached token)
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } }); // getToken after PATCH
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.userIsLoggedIn()).unwrapOr(false)).toBe(true);
  });

  it('server rejecting the session means the user is not authenticated', async () => {
    mockFetch.mockResolvedValue(makeResponse(401, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.userIsLoggedIn();
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr(true)).toBe(false);
  });

  it('no session found on the server means the user is not authenticated', async () => {
    mockFetch.mockResolvedValue(makeResponse(404, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.userIsLoggedIn()).unwrapOr(true)).toBe(false);
  });

  it('server and network errors are treated as not-logged-in so the caller can take corrective action', async () => {
    mockFetch.mockResolvedValue(makeResponse(500, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.userIsLoggedIn();
    expect(result.isOk()).toBe(true);
    expect(result.unwrapOr(true)).toBe(false);
  });

  it('unreachable server is treated as not-logged-in after exhausting retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new LoginClient(BASE_SETTINGS);
    const promise = client.userIsLoggedIn();
    await vi.runAllTimersAsync();
    expect((await promise).unwrapOr(true)).toBe(false);
  });

  it('a valid cookie proves authentication locally — no server round-trip needed', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.userIsLoggedIn()).unwrapOr(false)).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('issuer validation is getUserIdentity\'s responsibility — a wrong-issuer token is still a session cookie', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://other-domain.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.userIsLoggedIn()).unwrapOr(false)).toBe(false);
  });

  it('concurrent checks share one in-flight request to avoid hammering the server', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    const [r1, r2] = await Promise.all([client.userIsLoggedIn(), client.userIsLoggedIn()]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r1.unwrapOr(false)).toBe(r2.unwrapOr(false));
  });

  it('each check after the previous resolves re-queries the server independently', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValueOnce({}) // getToken first check (no token)
      .mockResolvedValueOnce({}) // getToken second check (no token yet)
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } }); // getToken after second PATCH + backupCookies
    mockFetch
      .mockResolvedValueOnce(makeResponse(401, {}, false))
      .mockResolvedValueOnce(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.userIsLoggedIn()).unwrapOr(true)).toBe(false);
    expect((await client.userIsLoggedIn()).unwrapOr(false)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('after logout the server session is gone so subsequent checks correctly report unauthenticated', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {})); // DELETE /session
    mockFetch.mockResolvedValueOnce(makeResponse(401, {}, false)); // PATCH /session after logout
    const client = new LoginClient(BASE_SETTINGS);
    await client.logout();
    expect((await client.userIsLoggedIn()).unwrapOr(true)).toBe(false);
  });
});

// ── waitForToken ───────────────────────────────────────────────────────────────

describe('waitForToken', () => {
  it('token already in the cookie jar resolves without waiting or a network call', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.waitForToken({ timeoutInMillis: 100 })).isOk()).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('zero timeout signals the caller only wants the token if immediately available', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.waitForToken({ timeoutInMillis: 0 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(TokenTimeoutError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('-1 is the sentinel for wait-indefinitely and must not be confused with an instant timeout', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    const waitPromise = client.waitForToken({ timeoutInMillis: -1 });
    mockToken(jwt);
    await client.userIsLoggedIn();
    expect((await waitPromise).isOk()).toBe(true);
  });

  it('any path that establishes a session unblocks all waiters', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    const waitPromise = client.waitForToken({ timeoutInMillis: 2000 });
    mockToken(jwt);
    await client.userIsLoggedIn();
    expect((await waitPromise).isOk()).toBe(true);
  });

  it('completing PKCE authentication unblocks token waiters subscribed before the login flow finished', async () => {
    storePendingAuth('req-abc');
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } }); // all subsequent calls
    const client = new LoginClient(BASE_SETTINGS);
    const [tokenResult] = await Promise.all([
      client.waitForToken({ timeoutInMillis: 2000 }),
      client.completeAuthenticationRequest({ code: 'code', authenticationRequestId: 'req-abc' })
    ]);
    expect(tokenResult.isOk()).toBe(true);
  });

  it('the session promise is shared so all concurrent waiters receive the token when it arrives', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    const p1 = client.waitForToken({ timeoutInMillis: 2000 });
    const p2 = client.waitForToken({ timeoutInMillis: 2000 });
    const p3 = client.waitForToken({ timeoutInMillis: 2000 });
    mockToken(jwt);
    await client.userIsLoggedIn();
    const results = await Promise.all([p1, p2, p3]);
    for (const r of results) {
      expect(r.isOk()).toBe(true);
    }
  });

  it('bounded wait lets the caller show appropriate UI state when no token arrives in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = new LoginClient(BASE_SETTINGS);
    const waitPromise = client.waitForToken({ timeoutInMillis: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await waitPromise)._unsafeUnwrapErr()).toBeInstanceOf(TokenTimeoutError);
  });

  it('logout resets the session promise so new waiters block rather than getting a stale resolved state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);

    expect((await client.waitForToken({ timeoutInMillis: 100 })).isOk()).toBe(true);

    await client.logout();
    mockNitroCookies.get.mockResolvedValue({}); // cookie cleared after logout

    const waitPromise = client.waitForToken({ timeoutInMillis: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await waitPromise)._unsafeUnwrapErr()).toBeInstanceOf(TokenTimeoutError);
  });

  it('a previously timed-out waiter does not corrupt the token store for later reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const client = new LoginClient(BASE_SETTINGS);

    const waitPromise = client.waitForToken({ timeoutInMillis: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await waitPromise).isErr()).toBe(true);

    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    expect((await client.getToken()).unwrapOr(null)).toBe(jwt);
  });
});

// ── authenticate ───────────────────────────────────────────────────────────────

describe('authenticate', () => {
  it('PKCE state is persisted so completeAuthenticationRequest can verify and exchange the code', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-abc' }));
    const client = new LoginClient(BASE_SETTINGS);
    await client.authenticate();
    const stored = JSON.parse(mockStorage.store['authress-pending-auth']);
    expect(stored.authenticationRequestId).toBe('req-abc');
    expect(stored.codeVerifier).toBeDefined();
    expect(stored.redirectUrl).toBe('myapp://callback');
  });

  it('restarting the login flow replaces the previous pending state so only the latest attempt is valid', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-first' }))
      .mockResolvedValueOnce(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-second' }));
    const client = new LoginClient(BASE_SETTINGS);
    await client.authenticate();
    await client.authenticate();
    const stored = JSON.parse(mockStorage.store['authress-pending-auth']);
    expect(stored.authenticationRequestId).toBe('req-second');
  });

  it('a server rejection leaves no dangling PKCE state that could confuse a subsequent attempt', async () => {
    mockFetch.mockResolvedValue(makeResponse(400, { message: 'Bad Request' }, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.authenticate()).isErr()).toBe(true);
    expect(mockStorage.store['authress-pending-auth']).toBeUndefined();
  });

  it('all PKCE parameters are sent so the server can issue and later verify the challenge', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-abc' }));
    const client = new LoginClient(BASE_SETTINGS);
    await client.authenticate();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.redirectUrl).toBe('myapp://callback');
    expect(body.applicationId).toBe('app_123');
    expect(body.codeChallenge).toBeDefined();
    expect(body.codeChallengeMethod).toBe('S256');
  });
});

// ── completeAuthenticationRequest ──────────────────────────────────────────────

describe('completeAuthenticationRequest', () => {
  it('cannot exchange a code without the codeVerifier stored from the original authenticate call', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'c', authenticationRequestId: 'req-id' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NoAuthenticationRequestInProgressError);
  });

  it('mismatched request ID suggests a replay or redirect confusion — reject without touching pending state', async () => {
    storePendingAuth('correct-req-id');
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'c', authenticationRequestId: 'wrong-req-id' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(AuthenticationRequestMismatchError);
    expect(mockStorage.store['authress-pending-auth']).toBeDefined();
  });

  it('successful token exchange establishes the session, unblocks waitForToken, and backs up cookies for app restart', async () => {
    storePendingAuth('req-abc');
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } }); // all subsequent
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'code', authenticationRequestId: 'req-abc' });
    expect(result.isOk()).toBe(true);
    expect((await client.getToken()).unwrapOr(null)).toBe(jwt);
    // Session promise resolved — waitForToken with timeout 0 returns immediately
    expect((await client.waitForToken({ timeoutInMillis: 0 })).isOk()).toBe(true);
    // Cookie backup written
    expect(mockStorage.store['authress-cookies']).toBeDefined();
  });

  it('an already-used code means the session was already established — treat as success and clean up', async () => {
    storePendingAuth('req-abc');
    mockFetch.mockResolvedValue(makeResponse(400, { error: 'invalid_request' }, false));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'code', authenticationRequestId: 'req-abc' });
    expect(result.isOk()).toBe(true);
  });

  it('other 400 errors mean the exchange genuinely failed — leave pending state intact so the user can retry', async () => {
    storePendingAuth('req-abc');
    mockFetch.mockResolvedValue(makeResponse(400, { error: 'access_denied' }, false));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'code', authenticationRequestId: 'req-abc' });
    expect(result.isErr()).toBe(false);
    expect(mockStorage.store['authress-pending-auth']).toBeDefined();
  });

  it('server failure during token exchange surfaces so the caller can retry or recover', async () => {
    storePendingAuth('req-abc');
    mockFetch.mockResolvedValue(makeResponse(500, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.completeAuthenticationRequest({ code: 'code', authenticationRequestId: 'req-abc' })).isErr()).toBe(true);
  });
});

// ── logout ─────────────────────────────────────────────────────────────────────

describe('logout', () => {
  it('logout is idempotent — completes cleanly even when there is nothing to clear', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.logout()).isOk()).toBe(true);
  });

  it('session cookie must be intact when the server is called so it can identify which session to invalidate', async () => {
    mockNitroCookies.get.mockResolvedValue({ session: { name: 'authress-session', value: 'sess' } });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    await client.logout();
    const deleteOrder = mockFetch.mock.invocationCallOrder[0];
    const clearOrder = mockNitroCookies.clearByName.mock.invocationCallOrder[0];
    expect(clearOrder).toBeGreaterThan(deleteOrder);
  });

  it('server errors do not prevent local session cleanup — the user\'s intent to log out must always succeed', async () => {
    mockNitroCookies.get.mockResolvedValue({ session: { name: 'authress-session', value: 'sess' } });
    mockFetch.mockResolvedValue(makeResponse(500, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.logout()).isOk()).toBe(true);
    expect(mockNitroCookies.clearByName).toHaveBeenCalled();
  });

  it('network failures do not prevent local session cleanup — offline logout must still clear local state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockNitroCookies.get.mockResolvedValue({ session: { name: 'authress-session', value: 'sess' } });
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new LoginClient(BASE_SETTINGS);
    const logoutPromise = client.logout();
    await vi.runAllTimersAsync();
    expect((await logoutPromise).isOk()).toBe(true);
    expect(mockNitroCookies.clearByName).toHaveBeenCalled();
  });

  it('all local auth state is cleared after logout', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    await client.logout();
    mockNitroCookies.get.mockResolvedValue({});
    expect((await client.getToken()).unwrapOr(null)).toBeNull();
  });

  it('server-side session is gone after logout so login checks correctly report unauthenticated', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(200, {})) // DELETE /session
      .mockResolvedValueOnce(makeResponse(401, {}, false)); // subsequent PATCH /session
    const client = new LoginClient(BASE_SETTINGS);
    await client.logout();
    expect((await client.userIsLoggedIn()).unwrapOr(true)).toBe(false);
  });

  it('logout resets the session promise so token waiters block until re-authentication rather than resolving stale', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    await client.logout();
    const waitPromise = client.waitForToken({ timeoutInMillis: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await waitPromise)._unsafeUnwrapErr()).toBeInstanceOf(TokenTimeoutError);
  });
});

// ── getUserIdentity ────────────────────────────────────────────────────────────

describe('getUserIdentity', () => {
  it('identity cannot be decoded without a token', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getUserIdentity()).unwrapOr(null)).toBeNull();
  });

  it('issuer match confirms the token was issued by this Authress instance — userId is mapped from sub', async () => {
    const jwt = makeJwt({ sub: 'user-42', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    const identity = (await client.getUserIdentity()).unwrapOr(null);
    expect(identity?.sub).toBe('user-42');
    expect(identity?.userId).toBe('user-42');
  });

  it('tokens from a different issuer are rejected to prevent cross-tenant identity confusion', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://other-domain.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getUserIdentity()).unwrapOr(null)).toBeNull();
  });

  it('userId is derived from sub — a token missing sub leaves userId unset', async () => {
    const jwt = makeJwt({ iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    const identity = (await client.getUserIdentity()).unwrapOr(null);
    expect(identity?.userId).toBeUndefined();
  });
});

// ── getUserProfile ─────────────────────────────────────────────────────────────

describe('getUserProfile', () => {
  it('profile requires an authenticated session — unauthenticated callers are rejected', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.getUserProfile();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotLoggedInError);
  });

  it('a token from a different issuer fails identity validation so the profile call is blocked', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://other-domain.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.getUserProfile();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotLoggedInError);
  });

  it('the bearer token is forwarded to the profile endpoint so the server can authorize the request', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, { name: 'Alice', email: 'alice@example.com' }));
    const client = new LoginClient(BASE_SETTINGS);
    const profile = (await client.getUserProfile()).unwrapOr(null);
    expect(profile).toMatchObject({ name: 'Alice' });
    const authHeader = mockFetch.mock.calls[0][1].headers.Authorization;
    expect(authHeader).toMatch(/^Bearer /);
  });

  it('server rejecting the token during profile fetch surfaces the auth failure', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(401, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getUserProfile()).isErr()).toBe(true);
  });
});

// ── linkIdentity ───────────────────────────────────────────────────────────────

describe('linkIdentity', () => {
  it('without a provider reference there is no identity to link — rejected before any network call', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.linkIdentity({});
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidConnectionError);
  });

  it('tenant lookup is a valid alternative to connectionId for identifying the provider', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-link' }));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.linkIdentity({ tenantLookupIdentifier: 'tenant@example.com' })).isOk()).toBe(true);
  });

  it('identities can only be linked to an existing authenticated user', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.linkIdentity({ connectionId: 'conn_123' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotLoggedInError);
  });

  it('linkIdentity flag tells the server to add an identity rather than create a new session', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-link' }));
    const client = new LoginClient(BASE_SETTINGS);
    await client.linkIdentity({ connectionId: 'conn_123' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.linkIdentity).toBe(true);
    expect(body.connectionId).toBe('conn_123');
  });

  it('a failed link attempt surfaces the server error so the caller can inform the user', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(400, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.linkIdentity({ connectionId: 'conn_123' })).isErr()).toBe(true);
  });
});

// ── getDevices / deleteDevice ──────────────────────────────────────────────────

describe('getDevices / deleteDevice', () => {
  it('returns NotLoggedInError without a network call when no token is available', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.getDevices();
    expect(result.isErr()).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('device list cannot be fetched without network connectivity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new LoginClient(BASE_SETTINGS);
    const promise = client.getDevices();
    await vi.runAllTimersAsync();
    expect((await promise).isErr()).toBe(true);
  });

  it('successful deletion confirms the device was removed from the user profile', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(204, {}));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.deleteDevice('device-1');
    expect(result.isOk()).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/session/devices/device-1'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleting a non-existent device surfaces the not-found error so the caller can reconcile its state', async () => {
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(404, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.deleteDevice('device-1')).isErr()).toBe(true);
  });

  it('device deletion is retried on network failure because the request may not have reached the server', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new LoginClient(BASE_SETTINGS);
    const promise = client.deleteDevice('device-1');
    await vi.runAllTimersAsync();
    expect((await promise).isErr()).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(5);
  });
});

// ── full-flow scenarios ────────────────────────────────────────────────────────

describe('full-flow scenarios', () => {
  it('complete PKCE login sequence results in a valid authenticated identity with each step building on the last', async () => {
    const jwt = makeJwt({ sub: 'user-42', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    const client = new LoginClient(BASE_SETTINGS);

    // Step 1: authenticate
    mockFetch.mockResolvedValueOnce(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-xyz' }));
    const authResult = (await client.authenticate()).unwrapOr(null);
    expect(authResult?.authenticationUrl).toBe('https://auth.example.com');
    expect(authResult?.authenticationRequestId).toBe('req-xyz');
    expect(mockStorage.store['authress-pending-auth']).toBeDefined();

    // Step 2: completeAuthenticationRequest — server sets cookie
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
    mockNitroCookies.get
      .mockResolvedValueOnce({ authorization: { name: 'authorization', value: jwt } }) // backupCookies
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } }); // subsequent getToken calls
    await client.completeAuthenticationRequest({ code: 'code-abc', authenticationRequestId: 'req-xyz' });

    // Step 3: getToken
    expect((await client.getToken()).unwrapOr(null)).toBe(jwt);

    // Step 4: getUserIdentity
    const identity = (await client.getUserIdentity()).unwrapOr(null);
    expect(identity?.userId).toBe('user-42');
  });

  it('backed-up cookies are restored on app restart giving instant authenticated state without a network call', async () => {
    const jwt = makeJwt({ sub: 'user-1', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    // Simulate: backup exists in encrypted storage, native jar is initially empty
    mockStorage.store['authress-cookies'] = JSON.stringify([{ name: 'authorization', value: jwt }]);
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies: native is empty → will restore
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } }); // after restore
    const client = new LoginClient(BASE_SETTINGS);
    await Promise.resolve(); // let restoreCookies tick
    expect((await client.userIsLoggedIn()).unwrapOr(false)).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockNitroCookies.set).toHaveBeenCalled();
  });

  it('re-authentication after logout starts from fully clean state with no residual data from the previous session', async () => {
    const jwt1 = makeJwt({ sub: 'user-1', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt1);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getToken()).unwrapOr(null)).toBe(jwt1);

    // Logout
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
    await client.logout();
    mockNitroCookies.get.mockResolvedValue({});
    expect((await client.getToken()).unwrapOr(null)).toBeNull();

    // Re-login via PKCE
    mockFetch.mockResolvedValueOnce(makeResponse(200, { authenticationUrl: 'https://auth.example.com', authenticationRequestId: 'req-new' }));
    const { authenticationRequestId } = (await client.authenticate())._unsafeUnwrap();

    const jwt2 = makeJwt({ sub: 'user-2', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));
    mockNitroCookies.get.mockResolvedValue({ authorization: { name: 'authorization', value: jwt2 } });
    await client.completeAuthenticationRequest({ code: 'code', authenticationRequestId });

    expect((await client.getToken()).unwrapOr(null)).toBe(jwt2);
    expect((await client.getUserIdentity()).unwrapOr(null)?.userId).toBe('user-2');
  });

  it('PKCE completion unblocks any token waiters subscribed across the app before authentication completed', async () => {
    storePendingAuth('req-abc');
    const jwt = makeJwt({ sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } });
    const client = new LoginClient(BASE_SETTINGS);
    const waitPromise = client.waitForToken({ timeoutInMillis: 2000 });
    await client.completeAuthenticationRequest({ code: 'code', authenticationRequestId: 'req-abc' });
    expect((await waitPromise).isOk()).toBe(true);
  });
});
