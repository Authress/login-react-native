import { Linking } from 'react-native';
import { Result, ok, err } from 'neverthrow';
import HttpClient, { AuthressHttpError, Logger } from './httpClient.ts';
import jwtManager from './jwtManager.ts';
import authStorageManager, { PendingAuthentication, SecurityContextError } from './authStorageManager.ts'; // SecurityContextError re-exported for public API
import { validateSettings, ValidatedSettings } from './settingsValidator.ts';
import {
  TokenTimeoutError, NoAuthenticationRequestInProgressError, AuthenticationRequestMismatchError,
  NotLoggedInError, InvalidConnectionError
} from './types.ts';
import type {
  Settings, AuthenticateResponse, AuthenticationParameters, LinkIdentityParameters,
  UserProfile, UserIdentity, TokenParameters, Device, AuthFlowError
} from './types.ts';

const defaultLogger: Logger = {
  debug() {},
  log() {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

export class LoginClient {
  private readonly settings: ValidatedSettings;
  private readonly httpClient: HttpClient;
  private readonly logger: Logger;
  private _sessionCheckPromise: Promise<boolean> = Promise.resolve(false);
  private _sessionCheckIsInProgress = false;
  private _sessionPromise!: Promise<void>;
  private _sessionResolver!: () => void;

  /**
   * @param settings Authress LoginClient settings — authressApiUrl, applicationId, and redirectUri are all required.
   * @param logger Optional logger (e.g. `console`) for debug and warning messages.
   */
  constructor(settings: Settings, logger?: Logger) {
    this.settings = validateSettings(settings);
    this.logger = logger ?? defaultLogger;
    this.httpClient = new HttpClient(this.settings.authressApiUrl, this.logger);
    this._resetSessionPromise();

    // fire-and-forget — restore cookies from encrypted storage into native cookie jar on startup
    authStorageManager.restoreCookies(this.settings.authressApiUrl);

    // Automatically handle deep link callbacks — no Linking boilerplate needed in app code
    Linking.addEventListener('url', async ({ url }) => {
      if (!url.startsWith(this.settings.redirectUri)) { return; }
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code') ?? '';
      const authenticationRequestId = parsed.searchParams.get('authenticationRequestId') ?? '';
      await this.completeAuthenticationRequest({ code, authenticationRequestId });
    });
  }

  private _resetSessionPromise(): void {
    this._sessionPromise = new Promise<void>(resolve => { this._sessionResolver = resolve; });
  }

  private _resolveSession(): void {
    this._sessionResolver?.();
  }

  // ── userIsLoggedIn ───────────────────────────────────────────────────────────

  /**
   * Checks if the user's session is still valid, even if their current token is expired. May call
   * Authress API to validate the session. Recommendation: call on every route change.
   * @returns `true` if a valid session exists, `false` if not logged in or if the server call fails.
   */
  async userIsLoggedIn(): Promise<boolean> {
    const tokenResult = await this.getToken();
    if (tokenResult.isOk()) {
      this._resolveSession();
      return true;
    }

    if (this._sessionCheckIsInProgress) {
      return this._sessionCheckPromise;
    }

    this._sessionCheckIsInProgress = true;
    this._sessionCheckPromise = this._doSessionCheck().finally(() => {
      this._sessionCheckIsInProgress = false;
    });

    return this._sessionCheckPromise;
  }

  private async _doSessionCheck(): Promise<boolean> {
    const sessionResult = await this.httpClient.patch('/session', {});
    if (sessionResult.isErr()) {
      return false;
    }

    const tokenResult = await this.getToken();
    if (tokenResult.isErr()) { return false; }

    await authStorageManager.backupCookies(this.settings.authressApiUrl);
    this._resolveSession();
    return true;
  }

  // ── authenticate ─────────────────────────────────────────────────────────────

  /**
   * Begins the login flow. Redirects the user to their selected connection/provider and then back to the
   * `redirectUri` from Settings. If neither `connectionId` nor `tenantLookupIdentifier` is specified the user
   * will be directed to the Authress hosted login page to select their preferred login method.
   * @returns `Ok` with the `authenticationUrl` to open in the device browser and the `authenticationRequestId` to pass to {@link completeAuthenticationRequest}.
   */
  async authenticate(options?: AuthenticationParameters): Promise<Result<AuthenticateResponse, AuthressHttpError | SecurityContextError>> {
    await authStorageManager.setAuthenticationRequest(null);

    let codeVerifier: string; let codeChallenge: string;
    try {
      ({ codeVerifier, codeChallenge } = await jwtManager.getAuthCodes());
    } catch (e) {
      return err(new SecurityContextError(String(e)));
    }

    const body = {
      redirectUrl: this.settings.redirectUri,
      applicationId: this.settings.applicationId,
      codeChallenge,
      codeChallengeMethod: 'S256',
      ...options
    };

    const postResult = await this.httpClient.post<{ authenticationUrl: string; authenticationRequestId: string }>('/authentication', body);
    if (postResult.isErr()) {return postResult;}

    const { authenticationUrl, authenticationRequestId } = postResult.value.data;
    const pendingAuth: PendingAuthentication = {
      codeVerifier,
      authenticationRequestId,
      redirectUrl: this.settings.redirectUri
    };

    const storeResult = await authStorageManager.setAuthenticationRequest(pendingAuth);
    if (storeResult.isErr()) {return storeResult;}

    return ok({ authenticationUrl, authenticationRequestId });
  }

  // ── completeAuthenticationRequest ────────────────────────────────────────────

  /**
   * Completes the PKCE login flow after the user returns from the Authress-hosted login page via the deep link.
   * Call this from your deep link handler with the `code` and `authenticationRequestId` query parameters from the redirect URL.
   * @returns `Ok` when the session is established, `Err` if parameters are wrong or the server rejects the exchange.
   */
  async completeAuthenticationRequest(params: { code: string; authenticationRequestId: string }): Promise<Result<void, AuthFlowError | AuthressHttpError>> {
    const pendingAuth = (await authStorageManager.getAuthenticationRequest()).unwrapOr(null);
    if (!pendingAuth) {return err(new NoAuthenticationRequestInProgressError());}
    if (pendingAuth.authenticationRequestId !== params.authenticationRequestId) {return err(new AuthenticationRequestMismatchError());}

    const tokenResult = await this.httpClient.post(`/authentication/${params.authenticationRequestId}/tokens`, {
      code: params.code,
      codeVerifier: pendingAuth.codeVerifier,
      redirectUri: pendingAuth.redirectUrl
    });

    if (tokenResult.isErr()) {
      const error = tokenResult.error;
      this.logger?.log({ title: '[Authress Login SDK] completeAuthenticationRequest token exchange failed', params, error });
      // already-used code — auth is done, clean up and return silently
      if (error.name !== 'AuthressHttpNetworkError' && error.status < 500) {
        return ok();
      }
      return tokenResult;
    }

    await authStorageManager.backupCookies(this.settings.authressApiUrl);
    this._resolveSession();
    return ok();
  }

  // ── getToken ─────────────────────────────────────────────────────────────────

  /**
   * Returns the current bearer token from the session cookie, or `null` if the user is not logged in.
   * Use {@link waitForToken} if you need to block until a session exists.
   */
  async getToken(): Promise<Result<string, NotLoggedInError>> {
    const cookieResult = await authStorageManager.getAuthorizationCookie(this.settings.authressApiUrl);
    const token = cookieResult.unwrapOr(null);
    if (!token) { return err(new NotLoggedInError()); }

    const payload = jwtManager.decode(token);
    if (!payload) { return err(new NotLoggedInError()); }

    const expectedOrigin = new URL(this.settings.authressApiUrl).origin;
    if (payload.iss !== expectedOrigin) { return err(new NotLoggedInError()); }

    return ok(token);
  }

  // ── waitForToken ──────────────────────────────────────────────────────────────

  /**
   * Waits until a bearer token is available and returns it. Blocks until {@link authenticate} +
   * {@link completeAuthenticationRequest} or {@link userIsLoggedIn} establishes a session.
   * Use in the `Authorization: Bearer <token>` header for API calls.
   * @returns `Ok(token)` when available, `Err({ code: 'TokenTimeout' })` if not available within `timeoutInMillis`.
   */
  async waitForToken(options?: TokenParameters): Promise<Result<void, TokenTimeoutError>> {
    const { timeoutInMillis = 5000 } = options ?? {};

    const tokenResult = await this.getToken();
    if (tokenResult.isOk()) {return ok();}

    if (timeoutInMillis === 0) {return err(new TokenTimeoutError());}

    const clampedTimeout = timeoutInMillis === -1 || timeoutInMillis > (2 ** 31 - 1) ? (2 ** 31 - 1) : timeoutInMillis;

    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<Result<void, TokenTimeoutError>>(resolve => {
      timeoutId = setTimeout(() => resolve(err(new TokenTimeoutError())), clampedTimeout);
    });

    const sessionPromise = this._sessionPromise.then(async () => {
      const newTokenResult = await this.getToken();
      return newTokenResult.isOk() ? ok() : err(new TokenTimeoutError());
    });

    try {
      return await Promise.race([timeoutPromise, sessionPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  // ── logout ───────────────────────────────────────────────────────────────────

  /**
   * Logs the user out, removing their session. If the user is not logged in this has no effect.
   */
  async logout(): Promise<Result<void, never>> {
    // DELETE /session while the native cookie jar is still intact so the server can identify the session
    await this.httpClient.delete('/session');
    // Now expire native cookies now that the server-side session is gone
    await authStorageManager.clear(this.settings.authressApiUrl);
    this._resetSessionPromise();
    return ok();
  }

  // ── getUserIdentity ──────────────────────────────────────────────────────────

  /**
   * Returns the decoded user identity from the current session token. Should be called after
   * {@link userIsLoggedIn} or it will return `null`. Use for populating user personalization in your UI.
   * For linked identities use {@link getUserProfile}.
   */
  async getUserIdentity(): Promise<Result<UserIdentity, NotLoggedInError>> {
    const idTokenResult = await authStorageManager.getUserCookie(this.settings.authressApiUrl);
    if (idTokenResult.isErr()) { return err(new NotLoggedInError()); }
    const idToken = idTokenResult.unwrapOr(null);

    const IdTokenPayload = jwtManager.decode(idToken);
    if (!IdTokenPayload) {return err(new NotLoggedInError());}

    const expectedOrigin = new URL(this.settings.authressApiUrl).origin;
    if (IdTokenPayload.iss !== expectedOrigin) {return err(new NotLoggedInError());}

    return ok({ ...IdTokenPayload, userId: IdTokenPayload.sub as string, sub: IdTokenPayload.sub as string });
  }

  // ── getUserProfile ───────────────────────────────────────────────────────────

  /**
   * Retrieves the user's full profile from Authress, including all linked identities.
   * @returns `Err({ code: 'NotLoggedIn' })` if the user is not logged in.
   */
  async getUserProfile(): Promise<Result<UserProfile, AuthressHttpError | NotLoggedInError>> {
    const tokenResult = await this.getToken();
    if (tokenResult.isErr()) { return err(new NotLoggedInError()); }
    const token = tokenResult.unwrapOr(null);

    const payload = jwtManager.decode(token);
    if (!payload) {return err(new NotLoggedInError());}

    const expectedOrigin = new URL(this.settings.authressApiUrl).origin;
    if (payload.iss !== expectedOrigin) {return err(new NotLoggedInError());}

    const profileResult = await this.httpClient.get<UserProfile>('/session/profile');
    if (profileResult.isErr()) {return profileResult;}

    return ok(profileResult.value.data);
  }

  // ── linkIdentity ─────────────────────────────────────────────────────────────

  /**
   * Links a new identity to the currently logged-in user. The user will be asked to authenticate
   * with the specified connection. Either `connectionId` or `tenantLookupIdentifier` is required.
   * @returns `Err({ code: 'NotLoggedIn' })` if the user is not logged in.
   */
  async linkIdentity(options: LinkIdentityParameters): Promise<Result<AuthenticateResponse, AuthressHttpError | SecurityContextError | NotLoggedInError | InvalidConnectionError>> {
    await authStorageManager.setAuthenticationRequest(null);

    if (!options.connectionId && !options.tenantLookupIdentifier) {
      return err(new InvalidConnectionError());
    }

    if ((await this.getToken()).isErr()) { return err(new NotLoggedInError()); }

    let codeVerifier: string; let codeChallenge: string;
    try {
      ({ codeVerifier, codeChallenge } = await jwtManager.getAuthCodes());
    } catch (e) {
      return err(new SecurityContextError(String(e)));
    }

    const body = {
      redirectUrl: this.settings.redirectUri,
      applicationId: this.settings.applicationId,
      codeChallenge,
      codeChallengeMethod: 'S256',
      linkIdentity: true,
      ...options
    };

    const postResult = await this.httpClient.post<{ authenticationUrl: string; authenticationRequestId: string }>('/authentication', body);
    if (postResult.isErr()) {return postResult;}

    const { authenticationUrl, authenticationRequestId } = postResult.value.data;
    const pendingAuth: PendingAuthentication = {
      codeVerifier,
      authenticationRequestId,
      redirectUrl: this.settings.redirectUri
    };

    const storeResult = await authStorageManager.setAuthenticationRequest(pendingAuth);
    if (storeResult.isErr()) {return storeResult;}

    return ok({ authenticationUrl, authenticationRequestId });
  }

  // ── getDevices ───────────────────────────────────────────────────────────────

  /**
   * Fetches the list of MFA devices registered to the current user.
   * @returns `Ok([])` if not logged in or no devices, `Err` on server/network failure.
   */
  async getDevices(): Promise<Result<Device[], AuthressHttpError | NotLoggedInError>> {
    const tokenResult = await this.getToken();
    if (tokenResult.isErr()) { return err(new NotLoggedInError()); }

    const result = await this.httpClient.get<{ devices?: Device[] }>('/session/devices');
    if (result.isErr()) {
      const error = result.error;
      if (error.name !== 'AuthressHttpNetworkError' && (error.status === 401 || error.status === 404)) {return ok([]);}
      return result;
    }
    return ok(result.value.data.devices ?? []);
  }

  // ── deleteDevice ─────────────────────────────────────────────────────────────

  /**
   * Removes an MFA device from the current user's profile.
   * @param deviceId The ID of the device to remove.
   */
  async deleteDevice(deviceId: string): Promise<Result<void, AuthressHttpError | NotLoggedInError>> {
    const tokenResult = await this.getToken();
    if (tokenResult.isErr()) { return err(new NotLoggedInError()); }

    const result = await this.httpClient.delete(`/session/devices/${deviceId}`);
    if (result.isErr()) {return result;}
    return ok();
  }
}
