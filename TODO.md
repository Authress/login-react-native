# Implementation TODO

## Setup
- [x] Update `package.json`: rename package, add peer deps (`react-native-keychain`, `react-native-quick-crypto`, `react-native-nitro-cookies`), remove browser-only deps
- [x] Move current `src/` → `authress-login-upstream/src/` (reference snapshot)
- [x] Configure `vitest` for TypeScript

## Module 1: `src/jwtManager.ts`
- [x] Implement with private `b64urlEncode`/`b64urlDecode` helpers (replaces standalone `base64url.ts`)
- [x] Write `tests/jwtManager.test.ts`: `decode` null/empty/valid/malformed, 10s exp subtraction, `decodeFull` header+payload, `decodeOrParse` object/JSON/JWT, `getAuthCodes` shape + codeChallenge = SHA256(codeVerifier), `calculateAntiAbuseHash` format + starts with `00` + no `window.crypto`
- [x] Deleted upstream `authress-login-upstream/src/jwtManager.js`

## Module 2: `src/settingsValidator.ts`
- [x] Implement `sanitizeUrl` + `validateSettings` (authressApiUrl required + sanitized, applicationId required + trimmed + sc_/ext_ guard, redirectUri required)
- [x] Write `tests/settingsValidator.test.ts`

## Module 3: `src/authStorageManager.ts`
- [x] Implement unified auth storage: id token, PKCE state, session cookie backup/restore/clear
- [x] Write `tests/authStorageManager.test.ts`: all methods via mocked `react-native-keychain` + `react-native-nitro-cookies`, no `localStorage`/`window`
- [x] Deleted upstream `authress-login-upstream/src/userIdentityTokenStorageManager.js` candidate — `cookieJar.ts` merged in, no separate module needed

## Module 5: `src/httpClient.ts`
- [ ] Write `tests/httpClient.test.ts`: constructor validation, `GET`/`POST`/`PATCH`/`DELETE` methods, `credentials: 'include'` always set, JSON parse, 4xx throws, retry on network errors (5x backoff), no retry on 4xx, `X-Powered-By` header, no `window`/`navigator`
- [ ] Implement `src/httpClient.ts`: port of `httpClient.js`, remove `windowManager`/`isLocalHost`/`navigator.onLine`/chrome-extension path, always use `credentials: 'include'`

## Module 6: `src/loginClient.ts`
- [x] Implement `src/loginClient.ts`
- [x] Write `tests/loginClient.test.ts` — basic coverage (constructor, happy paths, error paths)

## Module 7:
- [ ] Documentation: I think we need to start on the README, to include the expected usage, clarity on error types, how to match on the errors, full documentation, etc...

## Scenario tests — `tests/loginClient.scenarios.test.ts`

The basic tests cover the happy path for each method. These scenarios cover the full
state machine: every meaningful user state, the transitions between states, and the edge
cases that only appear when methods interact.

#### User states
| State | Description |
|---|---|
| **fresh** | No token, no cookies, no pending auth — brand-new install |
| **cached-valid** | Non-expired token in encrypted storage |
| **cached-expired-session-alive** | Token expired but session cookie still valid on server |
| **cached-expired-session-dead** | Token expired, server 401/404 on PATCH /session |
| **wrong-issuer** | Token in storage from a different authress domain |
| **pending-auth** | `authenticate()` called, `completeAuthenticationRequest()` not yet called |
| **logged-out** | Storage cleared, native cookies expired, session promise reset |
| **app-restart** | Token in encrypted storage, native cookie jar empty |

#### `userIsLoggedIn` scenarios
- [ ] **fresh** → PATCH /session 200 with token → stores token, returns `true`
- [ ] **fresh** → PATCH /session 200 without `id_token` → returns `false` (server replied but no token issued)
- [ ] **fresh** → PATCH /session 401 → `false`
- [ ] **fresh** → PATCH /session 404 → `false`
- [ ] **fresh** → PATCH /session 500 → `false` (no retry on 5xx)
- [ ] **fresh** → PATCH /session network error → `false` (after retries)
- [ ] **cached-valid** → returns `true` with zero network calls
- [ ] **cached-expired-session-alive** → PATCH returns new token → updates stored token, returns `true`
- [ ] **cached-expired-session-dead** → PATCH 401 → returns `false`, stored token not updated
- [ ] **wrong-issuer** token not expired → returns `true` (isLoggedIn does not validate issuer — that is `getUserIdentity`'s job)
- [ ] Two concurrent calls while **fresh** → exactly one PATCH, both callers get same result
- [ ] Sequential call after first resolves → second call re-checks (dedup window expired)
- [ ] **logged-out** → PATCH /session 401 → `false`

#### `waitForToken` scenarios
- [ ] **cached-valid** → returns token immediately, zero network calls
- [ ] `timeoutInMillis: 0`, no token → throws `TokenTimeout` immediately
- [ ] `timeoutInMillis: -1` → treated as "wait forever" (clamps, does not throw immediately)
- [ ] Token arrives via `userIsLoggedIn()` while waiting → `waitForToken` resolves with the token
- [ ] Token arrives via `completeAuthenticationRequest()` while waiting → `waitForToken` resolves
- [ ] Multiple concurrent `waitForToken` callers → all resolve when token arrives
- [ ] Timeout fires before token arrives → throws `TokenTimeout`
- [ ] **logged-out** state → `waitForToken` blocks again after logout (session promise was reset)
- [ ] Token arrives after a previous `waitForToken` already timed out → subsequent `getToken()` returns it

#### `authenticate` scenarios
- [ ] Stores pending auth with `codeVerifier`, `nonce = authenticationRequestId`, `redirectUrl`, `applicationId`
- [ ] Called twice → second call replaces pending auth (user is restarting the auth flow)
- [ ] POST /authentication 400 → throws, no pending auth stored
- [ ] Body includes `redirectUrl`, `applicationId`, `codeChallenge`, `codeChallengeMethod: 'S256'`

#### `completeAuthenticationRequest` scenarios
- [ ] No pending auth in storage → throws `NoAuthenticationRequestInProgress`
- [ ] Nonce mismatch → throws `AuthenticationRequestMismatch`, pending auth untouched
- [ ] 200 with `id_token` → stores token, resolves `_sessionPromise`, deletes pending auth, backups cookies
- [ ] 200 without `id_token` → does not store token, does not resolve `_sessionPromise`, still deletes pending auth
- [ ] 400 `invalid_request` → returns `false`, pending auth is NOT deleted (user may retry)
- [ ] 400 with any other error → throws, pending auth is NOT deleted
- [ ] 500 → throws

#### `logout` scenarios
- [ ] **fresh** (nothing stored) → completes without error
- [ ] **cached-valid**: encrypted storage cleared before DELETE /session is called
- [ ] Native cookies still present when DELETE /session is called (server can identify session)
- [ ] DELETE /session 200 → native cookies expired after the call
- [ ] DELETE /session 500 → error swallowed, native cookies still expired
- [ ] DELETE /session network error → error swallowed (after retries), native cookies still expired
- [ ] After logout: `getToken()` → `null`
- [ ] After logout: `userIsLoggedIn()` → `false`
- [ ] After logout: `waitForToken()` blocks (session promise was reset by logout)
- [ ] After logout → `authenticate()` → full PKCE flow works from fresh state

#### `getUserIdentity` scenarios
- [ ] No token → `null`
- [ ] Valid token, issuer matches `authressApiUrl` → returns payload with `userId = sub`
- [ ] Valid token, issuer does NOT match → `null`
- [ ] Token with no `sub` claim → `userId` is `undefined`
- [ ] **wrong-issuer** state: `getUserIdentity` returns `null` even though `userIsLoggedIn` returned `true`

#### `getUserProfile` scenarios
- [ ] No token → throws `NotLoggedIn`
- [ ] Wrong-issuer token (`getUserIdentity` → null) → throws `NotLoggedIn`
- [ ] Valid identity, GET /session/profile 200 → returns profile data
- [ ] Valid identity, GET /session/profile 401 → throws

#### `linkIdentity` scenarios
- [ ] No `connectionId` and no `tenantLookupIdentifier` → throws `InvalidConnection`
- [ ] Has `tenantLookupIdentifier` but no `connectionId` → valid, does not throw `InvalidConnection`
- [ ] Not logged in (`getUserIdentity` null) → throws `NotLoggedIn`
- [ ] Valid → POST body contains `linkIdentity: true` and `connectionId`
- [ ] POST fails → throws

#### `getDevices` / `deleteDevice` scenarios
- [ ] `getDevices` with stored token → GET with `Authorization: Bearer <token>`
- [ ] `getDevices` without token → GET without auth header
- [ ] `getDevices` network error → returns `[]`
- [ ] `deleteDevice` 204 → resolves void
- [ ] `deleteDevice` 404 → throws
- [ ] `deleteDevice` network error → retries then throws

#### Cross-method / full-flow scenarios
- [ ] **Full PKCE flow**: `authenticate()` → `completeAuthenticationRequest()` → `getToken()` → `getUserIdentity()` — all in sequence, each method sees the state the previous one left
- [ ] **App restart with valid token**: constructor restores cookies → `userIsLoggedIn()` returns `true` from cache, zero network calls
- [ ] **App restart with expired token, live session**: constructor restores cookies → `userIsLoggedIn()` PATCHes, gets new token → `true`
- [ ] **App restart with expired token, dead session**: `userIsLoggedIn()` → `false` → re-authenticate via PKCE flow
- [ ] **`waitForToken` waiting, `completeAuthenticationRequest` arrives**: resolves `waitForToken` with the new token
- [ ] **`waitForToken` waiting, `userIsLoggedIn` succeeds**: resolves `waitForToken`
- [ ] **Logout then re-login**: full flow works after logout with fresh state

## Module 7: `src/index.ts`
- [ ] Implement `src/index.ts`: export `LoginClient` and type aliases (`AuthenticateResponse`, `UserProfile`, `Device`, `SessionOptions`, `TokenParameters`, `AuthenticationParameters`, `Logger`)

## Documentation
- [ ] Create `src/platform/android/DeepLinkSetup.md`
- [ ] Create `src/platform/ios/DeepLinkSetup.md`

---

## Upstream files remaining to delete (after conversion)
- `authress-login-upstream/src/httpClient.js` — when `src/httpClient.ts` is complete
- `authress-login-upstream/src/userIdentityTokenStorageManager.js` — when `src/storageManager.ts` is complete
- `authress-login-upstream/src/index.js` — when `src/loginClient.ts` is complete
- `authress-login-upstream/src/windowManager.js` — not being ported (browser only)

---

## Platform notes

### Android
- Chrome Custom Tabs cookie store is **separate** from `android.webkit.CookieManager` — no bridge.
- RN fetch uses OkHttp with `ReactCookieJarContainer` — cookies round-trip automatically with `credentials: 'include'`.

### iOS
- SFSafariViewController uses Safari's cookie store. NSURLSession (RN fetch) uses `HTTPCookieStorage.shared`. Not shared.
- NSURLSession cookies round-trip automatically with `credentials: 'include'`.
