<p align="center">
  <img src="https://authress.io/static/images/linkedin-banner.png" alt="Authress media banner">
</p>

# @authress/login-react-native

<p align="center">
    <a href="https://www.npmjs.com/package/@authress/login-react-native" alt="Authress SDK on npm"><img src="https://badge.fury.io/js/@authress%2Flogin-react-native.svg"></a>
    <a href="./LICENSE" alt="Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg"></a>
    <a href="https://authress.io/community" alt="authress community"><img src="https://img.shields.io/badge/Community-Authress-fbaf0b.svg"></a>
</p>

Authress authentication SDK for React Native. Implements the full OAuth 2.0 login flow with native mobile storage and deep link handling for iOS and Android.

## Installation

```sh
npm install @authress/login-react-native react-native-encrypted-storage react-native-nitro-cookies react-native-quick-crypto
```

## Setup

### Android

**1. Configure the deep link intent filter**

In `android/app/src/main/AndroidManifest.xml`, add an intent filter to your main activity so Android routes the redirect URI back to your app:

```xml
<activity
  android:name=".MainActivity"
  android:launchMode="singleTask"
  ...>

  <!-- existing intent filters -->

  <intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <!-- DEFAULT: required for the activity to receive implicit intents from outside the app -->
    <category android:name="android.intent.category.DEFAULT" />
    <!-- BROWSABLE: required so Chrome and Chrome Custom Tabs can trigger this intent -->
    <category android:name="android.intent.category.BROWSABLE" />
    <!-- Must match the redirectUri you pass to LoginClient -->
    <data android:scheme="com.yourapp" android:host="auth" android:pathPrefix="/callback" />
  </intent-filter>
</activity>
```

**2. Forward the deep link to React Native**

In `android/app/src/main/java/.../MainActivity.kt`, if you aren't already processing intents, you need to accept the callback:

```kotlin
import android.content.Intent
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }
}
```

### iOS

**1. Register the URL scheme**

In `ios/YourApp/Info.plist`, add:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <!-- Must match the scheme in the redirectUri you pass to LoginClient -->
      <string>com.yourapp</string>
    </array>
  </dict>
</array>
```

**2. Forward the deep link to React Native**

In `ios/YourApp/AppDelegate.swift`:

```swift
import React

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ app: UIApplication, open url: URL,
                   options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    return RCTLinkingManager.application(app, open: url, options: options)
  }
}
```

Or in `AppDelegate.mm` (Objective-C):

```objc
#import <React/RCTLinkingManager.h>

- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options {
  return [RCTLinkingManager application:application openURL:url options:options];
}
```

**3. Install native pods**

```sh
cd ios && pod install
```

## Setup

Create a single `LoginClient` instance for your app — typically in a module you import wherever authentication is needed.

```ts
import { LoginClient } from '@authress/login-react-native';

export const loginClient = new LoginClient({
  // Your Authress custom domain — https://authress.io/app/#/setup?focus=domain
  authressApiUrl: 'https://login.yourdomain.com',

  // Your application ID — https://authress.io/app/#/manage?focus=applications
  applicationId: 'app_your-app-id',

  // The deep link URI Authress redirects back to after login.
  // Must match a registered redirect URI for the application.
  redirectUri: 'com.yourapp://auth/callback',
});
```

The constructor throws synchronously if any required setting is missing or invalid. It also automatically registers a deep link listener — when the user returns from the Authress login page, the SDK completes the authentication request without any extra wiring in your app.

### Optional logger

Pass any `console`-compatible logger as the second argument to see debug output:

```ts
const loginClient = new LoginClient(settings, console);
```

---

## Usage

All methods return a [`Result`](https://github.com/supermacro/neverthrow) from the `neverthrow` library. A `Result` is either `Ok(value)` or `Err(error)` — it never throws. Use `.match()`, `.isOk()`, `.isErr()`, or `.unwrapOr()` to handle both cases.

### Check if the user is logged in

Call this on every route change to keep session state current. It uses a cached token when available; otherwise it calls the Authress server.

```ts
const isLoggedIn = await loginClient.userIsLoggedIn();
if (isLoggedIn) {
  // session is valid — proceed to the app
} else {
  // no active session — show the login screen
}
```

### Log in — full authentication flow

Start the login request, open the browser, and the SDK takes care of the rest — it listens for the deep link redirect and completes the authentication automatically.

```ts
import { Linking } from 'react-native';

const result = await loginClient.authenticate({
  // Optional: specify a connection directly, or let the user pick on the Authress-hosted login page
  connectionId: 'google',
});

if (result.isOk()) {
  // Open the Authress-hosted login page in the device browser
  await Linking.openURL(result.value.authenticationUrl);
} else {
  console.error('Failed to start login', result.error);
}
```

When the user returns via the deep link, the SDK automatically calls `completeAuthenticationRequest` and resolves any pending `waitForToken` calls.

### Get a token for API calls

Use `waitForToken` when you need a bearer token and are willing to wait for a session to become active (e.g. on app startup while restoring a previous session).

```ts
const result = await loginClient.waitForToken({ timeoutInMillis: 5000 });

if (result.isOk()) {
  // Token is available — retrieve it with getToken()
  const tokenResult = await loginClient.getToken();
  if (tokenResult.isOk()) {
    const token = tokenResult.value;
    // Use as: Authorization: Bearer <token>
  }
} else {
  // result.error.code === 'TokenTimeoutError'
  // No token arrived within the timeout — redirect to login
}
```

Use `getToken()` directly when you need the token string immediately with no waiting:

```ts
const tokenResult = await loginClient.getToken();
if (tokenResult.isOk()) {
  const token = tokenResult.value;
}
// Returns Err(NotLoggedInError) immediately if there is no active session
```

### Get user identity

Returns decoded claims from the session token — useful for personalising the UI.

```ts
const result = await loginClient.getUserIdentity();

if (result.isOk()) {
  console.log(result.value.userId); // e.g. 'user|00001'
  // result.value also contains all other JWT claims
} else {
  // result.error.code === 'NotLoggedInError'
}
```

### Get full user profile

Fetches the user's profile from Authress, including all linked identities. Requires an active session.

```ts
const result = await loginClient.getUserProfile();

if (result.isOk()) {
  for (const { connection } of result.value.linkedIdentities) {
    console.log(connection.connectionId, connection.userId);
  }
} else if (result.error.code === 'NotLoggedInError') {
  // user is not logged in
} else {
  // HTTP error
}
```

### Log out

Clears the local session and invalidates the server-side session.

```ts
await loginClient.logout();
// Result is always Ok — errors during server-side logout are swallowed
```

After logout, `getToken()` returns `Err`, `waitForToken()` blocks again, and `userIsLoggedIn()` returns `false`.

### Link an additional identity

Links a new identity provider to the currently logged-in user. Follows the same flow as `authenticate` — open `authenticationUrl` in the browser and the SDK handles the redirect automatically. Either `connectionId` or `tenantLookupIdentifier` is required.

```ts
const result = await loginClient.linkIdentity({ connectionId: 'github' });

if (result.isOk()) {
  await Linking.openURL(result.value.authenticationUrl);
} else if (result.error.code === 'NotLoggedInError') {
  // user must be logged in to link an identity
} else {
  console.error('Link identity failed', result.error);
}
```

### MFA devices

```ts
// List registered MFA devices
const devicesResult = await loginClient.getDevices();
const devices = devicesResult.unwrapOr([]);

// Remove a device
const deleteResult = await loginClient.deleteDevice(deviceId);
if (deleteResult.isErr()) {
  console.error('Failed to remove device', deleteResult.error);
}
```

---

## Error handling

All errors are typed and carry a discriminating property. No method throws — use `.isErr()` to check for failure, then inspect the error.

### Application errors

Returned as `Err` values when a precondition is not met. Match on `error.code`:

| Class | `error.code` | When |
|---|---|---|
| `NotLoggedInError` | `'NotLoggedInError'` | Operation requires a logged-in session |
| `NoAuthenticationRequestInProgressError` | `'NoAuthenticationRequestInProgressError'` | `completeAuthenticationRequest` called with no pending login |
| `AuthenticationRequestMismatchError` | `'AuthenticationRequestMismatchError'` | `authenticationRequestId` in the redirect does not match the pending request |
| `TokenTimeoutError` | `'TokenTimeoutError'` | `waitForToken` timeout elapsed before a session arrived |
| `InvalidConnectionError` | `'InvalidConnectionError'` | `linkIdentity` called without `connectionId` or `tenantLookupIdentifier` |
| `SecurityContextError` | `'SecurityContextError'` | Encrypted storage is unavailable (device security context error) |

### HTTP errors

Returned when a network request to the Authress service fails. All three types are part of the `AuthressHttpError` union. Match on `error.name`:

| `error.name` | When |
|---|---|
| `'AuthressHttpNetworkError'` | Request never reached the server (network offline, DNS failure). Retried up to 5 times before returning this error. |
| `'AuthressHttpClientError'` | Authress returned a 4xx response |
| `'AuthressHttpServiceError'` | Authress returned a 5xx response |

Each HTTP error includes `url`, `method`, and `data`. Client and service errors also include `status` and `headers`.

### Example: handling all error cases

```ts
import type { AuthressHttpError } from '@authress/login-react-native';

const result = await loginClient.authenticate({ connectionId: 'google' });

if (result.isErr()) {
  const error = result.error;

  // Application errors — check error.code
  if (error.code === 'SecurityContextError') {
    // encrypted storage unavailable — device security context error
  }

  // HTTP errors — check error.name
  else if (error.name === 'AuthressHttpNetworkError') {
    // device is offline
  } else if (error.name === 'AuthressHttpClientError') {
    console.error(`Bad request: ${error.status}`, error.data);
  } else if (error.name === 'AuthressHttpServiceError') {
    console.error(`Authress service error: ${error.status}`);
  }
}
```

---

## API reference

### `new LoginClient(settings, logger?)`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `authressApiUrl` | `string` | Yes | Your Authress custom domain |
| `applicationId` | `string` | Yes | Your Authress application ID |
| `redirectUri` | `string` | Yes | Deep link URI registered for the application |
| `logger` | `Logger` | No | Optional logger (`console` works) |

Throws synchronously on invalid settings.

---

### `userIsLoggedIn()`

`Promise<boolean>`

Checks if a valid session exists. Uses the cached token when available; otherwise calls the Authress API. Returns `Ok(true)` if the session is active, `Ok(false)` if not logged in or if the server call fails.

Call on every route change.

---

### `authenticate(options?)`

`Promise<Result<AuthenticateResponse, AuthressHttpError | SecurityContextError>>`

Starts the login flow. Returns `authenticationUrl` to open in the device browser. The SDK automatically handles the deep link redirect to complete the flow.

| Option | Type | Description |
|---|---|---|
| `connectionId` | `string` | Log in directly with a specific provider connection |
| `tenantLookupIdentifier` | `string` | Resolve the connection from a tenant identifier |
| `inviteId` | `string` | Accept an invitation |
| `redirectUrl` | `string` | Override the redirect URI from settings |
| `scopes` | `string[]` | Additional scopes to request |
| `audiences` | `string[]` | Additional audiences for the token |
| `connectionProperties` | `Record<string, string>` | Provider-specific properties |
| `multiAccount` | `boolean` | Enable multi-account login (default: `false`) |

---

### `completeAuthenticationRequest(params)`

`Promise<Result<void, AuthFlowError | AuthressHttpError>>`

Completes the login flow after the deep link redirect. Called automatically by the SDK when the deep link is received — you only need to call this directly if you are managing the deep link yourself.

---

### `getToken()`

`Promise<Result<string, NotLoggedInError>>`

Returns the current bearer token, or `Err(NotLoggedInError)` if there is no active session. Does not wait or make network calls.

---

### `waitForToken(options?)`

`Promise<Result<void, TokenTimeoutError>>`

Blocks until a session token is available or the timeout elapses. Use `getToken()` after this resolves to retrieve the token string.

| Option | Type | Default | Description |
|---|---|---|---|
| `timeoutInMillis` | `number` | `5000` | Timeout in ms. `0` = fail immediately. `-1` = wait indefinitely. |

---

### `logout()`

`Promise<Result<void, never>>`

Clears the local session and calls the Authress logout endpoint. Always resolves `Ok` — server-side errors are swallowed.

---

### `getUserIdentity()`

`Promise<Result<UserIdentity, NotLoggedInError>>`

Returns decoded claims from the session token. `identity.userId` is the user's unique identifier. The identity object also contains all other JWT claims.

---

### `getUserProfile()`

`Promise<Result<UserProfile, AuthressHttpError | NotLoggedInError>>`

Fetches the user's full profile from Authress, including all linked identities (`profile.linkedIdentities`).

---

### `linkIdentity(options)`

`Promise<Result<AuthenticateResponse, AuthressHttpError | SecurityContextError | NotLoggedInError | InvalidConnectionError>>`

Links a new identity provider to the current user. Returns `authenticationUrl` to open in the device browser. Either `connectionId` or `tenantLookupIdentifier` is required.

---

### `getDevices()`

`Promise<Result<Device[], AuthressHttpError | NotLoggedInError>>`

Returns the list of MFA devices registered for the current user. Returns `Ok([])` if not logged in or no devices are registered.

---

### `deleteDevice(deviceId)`

`Promise<Result<void, AuthressHttpError | NotLoggedInError>>`

Removes the MFA device with the given `deviceId`.
