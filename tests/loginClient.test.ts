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
  get: vi.fn(async () => ({} as Record<string, { name: string; value: string }>)),
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

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

function makeResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return { ok, status, headers: new Headers(), text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)) };
}

function mockToken(jwt: string) {
  mockNitroCookies.get.mockResolvedValue({ authorization: { name: 'authorization', value: jwt } });
}

const BASE_SETTINGS = {
  authressApiUrl: 'https://my-app.login.authress.io',
  applicationId: 'app_123',
  redirectUri: 'myapp://callback'
};

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

// ── constructor ───────────────────────────────────────────────────────────────

describe('LoginClient constructor', () => {
  it('throws when authressApiUrl is missing', () => {
    expect(() => new LoginClient({ ...BASE_SETTINGS, authressApiUrl: '' })).toThrow();
  });

  it('throws when applicationId is missing', () => {
    expect(() => new LoginClient({ ...BASE_SETTINGS, applicationId: '' })).toThrow();
  });

  it('throws when redirectUri is missing', () => {
    expect(() => new LoginClient({ ...BASE_SETTINGS, redirectUri: '' })).toThrow();
  });

  it('throws when applicationId starts with sc_', () => {
    expect(() => new LoginClient({ ...BASE_SETTINGS, applicationId: 'sc_abc' })).toThrow(/service client/i);
  });

  it('constructs successfully with valid settings', () => {
    expect(() => new LoginClient(BASE_SETTINGS)).not.toThrow();
  });

  it('calls restoreCookies on init', async () => {
    new LoginClient(BASE_SETTINGS);
    await Promise.resolve();
    expect(mockNitroCookies.get).toHaveBeenCalled();
  });
});

// ── userIsLoggedIn ────────────────────────────────────────────────────────────

describe('LoginClient.userIsLoggedIn', () => {
  it('returns true from cached cookie token without network call', async () => {
    const jwt = makeJwt({ sub: 'user-1', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.userIsLoggedIn()).unwrapOr(false)).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls PATCH /session when no cached token', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValueOnce({}) // getToken check (no cached token)
      .mockResolvedValue({ authorization: { name: 'authorization', value: jwt } }); // getToken after PATCH
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.userIsLoggedIn();
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/session'), expect.objectContaining({ method: 'PATCH' }));
    expect(result.unwrapOr(false)).toBe(true);
  });

  it('backs up cookies after PATCH /session succeeds', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValueOnce({}) // getToken check (no cookie yet)
      .mockResolvedValueOnce({ authorization: { name: 'authorization', value: jwt } }) // getToken after PATCH
      .mockResolvedValueOnce({ 'authress-session': { name: 'authress-session', value: 'sess', domain: 'my-app.login.authress.io', path: '/' } }); // backupCookies
    const client = new LoginClient(BASE_SETTINGS);
    await client.userIsLoggedIn();
    expect(mockStorage.setItem).toHaveBeenCalledWith('authress-cookies', expect.any(String));
  });

  it('returns false when PATCH /session returns 4xx', async () => {
    mockFetch.mockResolvedValue(makeResponse(404, { message: 'Not Found' }, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.userIsLoggedIn()).unwrapOr(false)).toBe(false);
  });

  it('returns false when PATCH /session throws network error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new LoginClient(BASE_SETTINGS);
    const promise = client.userIsLoggedIn();
    await vi.runAllTimersAsync();
    expect((await promise).unwrapOr(false)).toBe(false);
  });

  it('deduplicates concurrent calls', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    const [r1, r2] = await Promise.all([client.userIsLoggedIn(), client.userIsLoggedIn()]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(r1.unwrapOr(false)).toBe(r2.unwrapOr(false));
  });
});

// ── authenticate ──────────────────────────────────────────────────────────────

describe('LoginClient.authenticate', () => {
  it('POSTs to /authentication and returns authenticationUrl', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com/login', authenticationRequestId: 'req_123' }));
    const client = new LoginClient(BASE_SETTINGS);
    const result = (await client.authenticate()).unwrapOr(null);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/authentication'), expect.objectContaining({ method: 'POST' }));
    expect(result?.authenticationUrl).toBe('https://auth.example.com/login');
    expect(result?.authenticationRequestId).toBe('req_123');
  });

  it('stores pending authentication in authStorageManager', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com/login', authenticationRequestId: 'req_123' }));
    const client = new LoginClient(BASE_SETTINGS);
    await client.authenticate();
    expect(mockStorage.setItem).toHaveBeenCalledWith('authress-pending-auth', expect.stringContaining('codeVerifier'));
  });

  it('includes redirectUri and applicationId in request body', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com/login', authenticationRequestId: 'req_123' }));
    const client = new LoginClient(BASE_SETTINGS);
    await client.authenticate();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.redirectUrl).toBe('myapp://callback');
    expect(body.applicationId).toBe('app_123');
    expect(body.codeChallenge).toBeDefined();
    expect(body.codeChallengeMethod).toBe('S256');
  });

  it('returns Err on 4xx response', async () => {
    mockFetch.mockResolvedValue(makeResponse(400, { message: 'Bad Request' }, false));
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.authenticate()).isErr()).toBe(true);
  });
});

// ── completeAuthenticationRequest ─────────────────────────────────────────────

describe('LoginClient.completeAuthenticationRequest', () => {
  const pendingAuth = { codeVerifier: 'verifier-abc', authenticationRequestId: 'req-xyz', redirectUrl: 'myapp://callback', applicationId: 'app_123' };

  beforeEach(() => {
    mockStorage.store['authress-pending-auth'] = JSON.stringify(pendingAuth);
  });

  it('POSTs to /authentication/{authenticationRequestId}/tokens', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    await client.completeAuthenticationRequest({ code: 'code-abc', authenticationRequestId: 'req-xyz' });
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/authentication/req-xyz/tokens'), expect.anything());
  });

  it('backs up cookies after successful exchange', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    mockNitroCookies.get
      .mockResolvedValueOnce({}) // restoreCookies on init
      .mockResolvedValueOnce({ 'authress-session': { name: 'authress-session', value: 'sess', domain: 'my-app.login.authress.io', path: '/' } }); // backupCookies
    const client = new LoginClient(BASE_SETTINGS);
    await client.completeAuthenticationRequest({ code: 'code-abc', authenticationRequestId: 'req-xyz' });
    expect(mockStorage.setItem).toHaveBeenCalledWith('authress-cookies', expect.any(String));
  });

  it('returns Err when authenticationRequestId does not match', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'code-abc', authenticationRequestId: 'wrong-req-id' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(AuthenticationRequestMismatchError);
  });

  it('returns Err when there is no authentication request in progress', async () => {
    delete mockStorage.store['authress-pending-auth'];
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'code-abc', authenticationRequestId: 'req-xyz' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NoAuthenticationRequestInProgressError);
  });

  it('handles invalid_request error gracefully and returns Ok', async () => {
    mockFetch.mockResolvedValue(makeResponse(400, { error: 'invalid_request' }, false));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.completeAuthenticationRequest({ code: 'code-abc', authenticationRequestId: 'req-xyz' });
    expect(result.isOk()).toBe(true);
  });
});

// ── getToken ──────────────────────────────────────────────────────────────────

describe('LoginClient.getToken', () => {
  it('returns token from authorization cookie', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getToken()).unwrapOr(null)).toBe(jwt);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when no authorization cookie exists', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getToken()).unwrapOr(null)).toBeNull();
  });
});

// ── waitForToken ──────────────────────────────────────────────────────────────

describe('LoginClient.waitForToken', () => {
  it('returns token immediately when already in cookie', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.waitForToken({ timeoutInMillis: 100 })).isOk()).toBe(true);
  });

  it('returns Err TokenTimeout when no token within timeout', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.waitForToken({ timeoutInMillis: 0 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(TokenTimeoutError);
  });
});

// ── logout ────────────────────────────────────────────────────────────────────

describe('LoginClient.logout', () => {
  it('DELETEs /session', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new LoginClient(BASE_SETTINGS);
    await client.logout();
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/session'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('clears native cookies on logout', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    mockNitroCookies.get.mockResolvedValue({
      authorization: { name: 'authorization', value: 'tok', domain: 'my-app.login.authress.io', path: '/' }
    });
    const client = new LoginClient(BASE_SETTINGS);
    await client.logout();
    expect(mockNitroCookies.clearByName).toHaveBeenCalled();
  });

  it('swallows HTTP errors from DELETE /session', async () => {
    mockFetch.mockResolvedValue(makeResponse(500, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.logout();
    expect(result.isOk()).toBe(true);
  });

  it('swallows network errors from DELETE /session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new LoginClient(BASE_SETTINGS);
    const promise = client.logout();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.isOk()).toBe(true);
  });
});

// ── getUserIdentity ───────────────────────────────────────────────────────────

describe('LoginClient.getUserIdentity', () => {
  it('returns null when no token in cookie', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getUserIdentity()).unwrapOr(null)).toBeNull();
  });

  it('decodes and returns the JWT payload with userId = sub', async () => {
    const jwt = makeJwt({ sub: 'user-1', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    const identity = (await client.getUserIdentity()).unwrapOr(null);
    expect(identity?.sub).toBe('user-1');
    expect(identity?.userId).toBe('user-1');
  });

  it('returns null when issuer does not match hostUrl', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://other-domain.com', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    const client = new LoginClient(BASE_SETTINGS);
    expect((await client.getUserIdentity()).unwrapOr(null)).toBeNull();
  });
});

// ── getUserProfile ────────────────────────────────────────────────────────────

describe('LoginClient.getUserProfile', () => {
  it('returns Err NotLoggedIn when no identity', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.getUserProfile();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotLoggedInError);
  });

  it('calls GET /session/profile with Bearer token', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, { name: 'Test User', email: 'test@example.com' }));
    const client = new LoginClient(BASE_SETTINGS);
    const profile = (await client.getUserProfile()).unwrapOr(null);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/session/profile'), expect.objectContaining({ method: 'GET' }));
    expect(profile).toMatchObject({ name: 'Test User' });
  });
});

// ── linkIdentity ──────────────────────────────────────────────────────────────

describe('LoginClient.linkIdentity', () => {
  it('returns Err InvalidConnection when connectionId is missing', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.linkIdentity({});
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidConnectionError);
  });

  it('returns Err NotLoggedIn when user has no identity', async () => {
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.linkIdentity({ connectionId: 'conn_123' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(NotLoggedInError);
  });

  it('POSTs to /authentication with linkIdentity: true', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, { authenticationUrl: 'https://auth.example.com/link', authenticationRequestId: 'req_link' }));
    const client = new LoginClient(BASE_SETTINGS);
    await client.linkIdentity({ connectionId: 'conn_123' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.linkIdentity).toBe(true);
    expect(body.connectionId).toBe('conn_123');
  });
});

// ── getDevices ────────────────────────────────────────────────────────────────

describe('LoginClient.getDevices', () => {
  it('calls GET /session/devices with Bearer token', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(200, { devices: [{ deviceId: 'd1' }] }));
    const client = new LoginClient(BASE_SETTINGS);
    const devices = (await client.getDevices()).unwrapOr(null);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/session/devices'), expect.anything());
    expect(devices).toEqual([{ deviceId: 'd1' }]);
  });

  it('returns Err on network error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new LoginClient(BASE_SETTINGS);
    const promise = client.getDevices();
    await vi.runAllTimersAsync();
    expect((await promise).isErr()).toBe(true);
  });
});

// ── deleteDevice ──────────────────────────────────────────────────────────────

describe('LoginClient.deleteDevice', () => {
  it('calls DELETE /session/devices/{id} with Bearer token', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(204, {}));
    const client = new LoginClient(BASE_SETTINGS);
    await client.deleteDevice('device-1');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/session/devices/device-1'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('returns Err on error', async () => {
    const jwt = makeJwt({ sub: 'u', iss: 'https://my-app.login.authress.io', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockToken(jwt);
    mockFetch.mockResolvedValue(makeResponse(404, {}, false));
    const client = new LoginClient(BASE_SETTINGS);
    const result = await client.deleteDevice('device-1');
    expect(result.isErr()).toBe(true);
  });
});
