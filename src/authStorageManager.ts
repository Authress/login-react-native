import { ResultAsync } from 'neverthrow';
import EncryptedStorage from 'react-native-encrypted-storage';
import NitroCookies from 'react-native-nitro-cookies';

const PENDING_AUTH_KEY = 'authress-pending-auth';
const COOKIES_BACKUP_KEY = 'authress-cookies';

export interface PendingAuthentication {
  codeVerifier: string;
  authenticationRequestId: string;
  redirectUrl: string;
}

export class SecurityContextError extends Error {
  readonly code = 'SecurityContextError' as const;
  constructor(message: string) { super(message); this.name = 'SecurityContextError'; }
}

export interface StoredCookie {
  name: string;
  value: string;
}

class AuthStorageManager {
  // ── PKCE state ──────────────────────────────────────────────────────────────

  setAuthenticationRequest(state?: PendingAuthentication | null): ResultAsync<void, SecurityContextError> {
    return ResultAsync.fromPromise(
      state
        ? EncryptedStorage.setItem(PENDING_AUTH_KEY, JSON.stringify(state))
        : EncryptedStorage.removeItem(PENDING_AUTH_KEY),
      e => new SecurityContextError(String(e))
    );
  }

  getAuthenticationRequest(): ResultAsync<PendingAuthentication | null, never> {
    return ResultAsync.fromSafePromise(
      EncryptedStorage.getItem(PENDING_AUTH_KEY)
        .then(raw => raw ? JSON.parse(raw) as PendingAuthentication : null)
        .catch(() => null)
    );
  }

  // ── cookies ─────────────────────────────────────────────────────────────────

  backupCookies(url: string): ResultAsync<void, never> {
    return ResultAsync.fromSafePromise(
      NitroCookies.get(url)
        .then(async cookies => {
          if (!Object.keys(cookies).length) {return;}
          await EncryptedStorage.setItem(COOKIES_BACKUP_KEY, JSON.stringify(Object.values(cookies).map(c => ({ name: c.name, value: c.value }))));
        })
        .catch(() => {})
    );
  }

  restoreCookies(url: string): ResultAsync<void, never> {
    return ResultAsync.fromSafePromise(
      (async () => {
        const existing = await NitroCookies.get(url);
        if (Object.keys(existing).length) {return;}

        const raw = await EncryptedStorage.getItem(COOKIES_BACKUP_KEY);
        if (!raw) {return;}

        const cookies: StoredCookie[] = JSON.parse(raw);
        await Promise.all(
          cookies.map(c => NitroCookies.set(url, { name: c.name, value: c.value, path: '/', httpOnly: true, secure: true }))
        );
      })().catch(() => {})
    );
  }

  getAuthorizationCookie(url: string): ResultAsync<string | null, never> {
    return ResultAsync.fromSafePromise(
      NitroCookies.get(url)
        .then(cookies => cookies.authorization?.value ?? null)
        .catch(() => null)
    );
  }

  getCookieBackups(): ResultAsync<StoredCookie[] | null, never> {
    return ResultAsync.fromSafePromise(
      EncryptedStorage.getItem(COOKIES_BACKUP_KEY)
        .then(raw => raw ? JSON.parse(raw) as StoredCookie[] : null)
        .catch(() => null)
    );
  }

  // ── clear ───────────────────────────────────────────────────────────────────

  /** Clears all native cookies for the given URL and removes all encrypted storage keys. */
  clear(url: string): ResultAsync<void, never> {
    return ResultAsync.fromSafePromise(
      (async () => {
        await EncryptedStorage.removeItem(COOKIES_BACKUP_KEY);
        await EncryptedStorage.removeItem(PENDING_AUTH_KEY);
        try {
          const cookies = await NitroCookies.get(url);
          await Promise.all(
            Object.keys(cookies).map(name => NitroCookies.clearByName(url, name).catch(() => {}))
          );
        } catch (_) {
          /* best effort */
        }
      })().catch(() => {})
    );
  }
}

export default new AuthStorageManager();
