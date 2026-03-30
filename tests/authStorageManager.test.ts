import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEncryptedStorage = vi.hoisted(() => {
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

vi.mock('react-native-encrypted-storage', () => ({ default: mockEncryptedStorage }));
vi.mock('react-native-nitro-cookies', () => ({ default: mockNitroCookies }));

import authStorageManager from '../src/authStorageManager.ts';

beforeEach(() => {
  for (const key of Object.keys(mockEncryptedStorage.store)) {delete mockEncryptedStorage.store[key];}
  vi.clearAllMocks();

  mockEncryptedStorage.setItem.mockImplementation(async (key: string, value: string) => { mockEncryptedStorage.store[key] = value; });
  mockEncryptedStorage.getItem.mockImplementation(async (key: string) => mockEncryptedStorage.store[key] ?? null);
  mockEncryptedStorage.removeItem.mockImplementation(async (key: string) => { delete mockEncryptedStorage.store[key]; });
  mockNitroCookies.get.mockResolvedValue({});
  mockNitroCookies.set.mockResolvedValue(undefined);
  mockNitroCookies.clearByName.mockResolvedValue(undefined);
});

// ── pending authentication ────────────────────────────────────────────────────

describe('authStorageManager — pending authentication', () => {
  const pendingAuth = { codeVerifier: 'verifier-abc', authenticationRequestId: 'nonce-xyz', redirectUrl: 'myapp://cb', applicationId: 'app_1' };

  it('returns null when no authentication request is stored', async () => {
    expect((await authStorageManager.getAuthenticationRequest()).unwrapOr(null)).toBeNull();
  });

  it('stores and retrieves a pending authentication request', async () => {
    await authStorageManager.setAuthenticationRequest(pendingAuth);
    expect((await authStorageManager.getAuthenticationRequest()).unwrapOr(null)).toEqual(pendingAuth);
  });

  it('returns null after setAuthenticationRequest(null)', async () => {
    await authStorageManager.setAuthenticationRequest(pendingAuth);
    await authStorageManager.setAuthenticationRequest(null);
    expect((await authStorageManager.getAuthenticationRequest()).unwrapOr(null)).toBeNull();
  });

  it('returns null after clear()', async () => {
    await authStorageManager.setAuthenticationRequest(pendingAuth);
    await authStorageManager.clear('https://my-app.login.authress.io');
    expect((await authStorageManager.getAuthenticationRequest()).unwrapOr(null)).toBeNull();
  });
});

// ── cookie backup/restore ─────────────────────────────────────────────────────

describe('authStorageManager — cookies', () => {
  const url = 'https://my-app.login.authress.io';
  const serverCookies: Record<string, { name: string; value: string; domain: string; path: string }> = {
    'authress-session': { name: 'authress-session', value: 'abc123', domain: 'my-app.login.authress.io', path: '/' },
    'authorization': { name: 'authorization', value: 'tok456', domain: 'my-app.login.authress.io', path: '/' }
  };

  it('backup saves all cookies from the native store', async () => {
    mockNitroCookies.get.mockResolvedValue(serverCookies);
    await authStorageManager.backupCookies(url);
    expect(mockEncryptedStorage.setItem).toHaveBeenCalled();
    const backup = (await authStorageManager.getCookieBackups()).unwrapOr(null);
    expect(backup).toHaveLength(2);
    expect(backup!.find(c => c.name === 'authress-session')?.value).toBe('abc123');
    expect(backup!.find(c => c.name === 'authorization')?.value).toBe('tok456');
  });

  it('backup skips when no cookies exist in native store', async () => {
    mockNitroCookies.get.mockResolvedValue({});
    await authStorageManager.backupCookies(url);
    expect(mockEncryptedStorage.setItem).not.toHaveBeenCalled();
  });

  it('restore writes all backed-up cookies into native store when native is empty', async () => {
    mockEncryptedStorage.store['authress-cookies'] = JSON.stringify(Object.values(serverCookies).map(c => ({ name: c.name, value: c.value })));
    mockNitroCookies.get.mockResolvedValue({});
    await authStorageManager.restoreCookies(url);
    expect(mockNitroCookies.set).toHaveBeenCalledWith(url, expect.objectContaining({ name: 'authress-session', value: 'abc123' }));
    expect(mockNitroCookies.set).toHaveBeenCalledWith(url, expect.objectContaining({ name: 'authorization', value: 'tok456' }));
  });

  it('restore skips when native store already has cookies', async () => {
    mockEncryptedStorage.store['authress-cookies'] = JSON.stringify(Object.values(serverCookies).map(c => ({ name: c.name, value: c.value })));
    mockNitroCookies.get.mockResolvedValue(serverCookies);
    await authStorageManager.restoreCookies(url);
    expect(mockNitroCookies.set).not.toHaveBeenCalled();
  });

  it('restore skips when no backup exists', async () => {
    mockNitroCookies.get.mockResolvedValue({});
    await authStorageManager.restoreCookies(url);
    expect(mockNitroCookies.set).not.toHaveBeenCalled();
  });
});

// ── clear ─────────────────────────────────────────────────────────────────────

describe('authStorageManager — clear', () => {
  const url = 'https://my-app.login.authress.io';

  it('clears pending authentication, cookie backup, and all native cookies', async () => {
    await authStorageManager.setAuthenticationRequest({ codeVerifier: 'v', authenticationRequestId: 'n', redirectUrl: 'myapp://cb', applicationId: 'app_1' });
    mockEncryptedStorage.store['authress-cookies'] = JSON.stringify([{ name: 'authress-session', value: 'x' }]);
    mockNitroCookies.get.mockResolvedValue({
      'authress-session': { name: 'authress-session', value: 'x', domain: 'my-app.login.authress.io', path: '/' },
      'authorization': { name: 'authorization', value: 'y', domain: 'my-app.login.authress.io', path: '/' }
    });

    await authStorageManager.clear(url);

    expect((await authStorageManager.getAuthenticationRequest()).unwrapOr(null)).toBeNull();
    expect((await authStorageManager.getCookieBackups()).unwrapOr(null)).toBeNull();
    expect(mockNitroCookies.clearByName).toHaveBeenCalledWith(url, 'authress-session');
    expect(mockNitroCookies.clearByName).toHaveBeenCalledWith(url, 'authorization');
  });

  it('does not throw if native cookie clear fails', async () => {
    mockNitroCookies.get.mockResolvedValue({ 'authress-session': { name: 'authress-session', value: 'x', domain: 'my-app.login.authress.io', path: '/' } });
    mockNitroCookies.clearByName.mockRejectedValue(new Error('native error'));
    const result = await authStorageManager.clear(url);
    expect(result.isOk()).toBe(true);
  });
});
