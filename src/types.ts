export interface Settings {
  /** Your Authress custom domain - see https://authress.io/app/#/setup?focus=domain */
  authressApiUrl: string;
  /** The Authress applicationId for this app - see https://authress.io/app/#/manage?focus=applications */
  applicationId: string;
  /** The deep link URI that Authress will redirect back to after authentication. Must match a registered redirect URI for the application. */
  redirectUri: string;
}

export interface AuthenticateResponse {
  /** The second step of the authentication flow requires the user to log in with their selected provider. Redirect the user to this location. */
  authenticationUrl?: string;
  authenticationRequestId: string;
}

export interface AuthenticationParameters {
  /** Specify which provider connection that user would like to use to log in - see https://authress.io/app/#/manage?focus=connections */
  connectionId?: string;
  /** Instead of connectionId, specify the tenant lookup identifier to log the user with the mapped tenant. Takes precedent over the connectionId - see https://authress.io/app/#/manage?focus=tenants */
  tenantLookupIdentifier?: string;
  /** Invite to use to login, only one of the connectionId, tenantLookupIdentifier, or the inviteId is required. */
  inviteId?: string;
  /** Store the credentials response in the specified location. Options are either 'cookie' or 'query'. (Default: **cookie**) */
  responseLocation?: string;
  /** The type of credentials returned in the response. The list of options is any of 'code token id_token' separated by a space. (Default: **token id_token**) */
  flowType?: string;
  /** A list of scopes to populate into the scope claim of the generated JWT. */
  scopes?: Array<string>;
  /** Specify where the provider should redirect the user to in your application. Must be a valid redirect url matching what is defined in the application in the Authress Management portal. (Default: **redirectUri from Settings**) */
  redirectUrl?: string;
  /** A list of audiences to add to the JWT in the `aud` claim. This list must be a subset of the audiences defined for the application. */
  audiences?: Array<string>;
  /** Overrides the connection specific properties from the Authress Identity Connection to pass to the identity provider */
  connectionProperties?: Record<string, string>;
  /** Enable multi-account login. (Default: **false**) */
  multiAccount?: boolean;
}

export interface LinkIdentityParameters {
  /** Specify which provider connection that user would like to use to log in - see https://authress.io/app/#/manage?focus=connections */
  connectionId?: string;
  /** Instead of connectionId, specify the tenant lookup identifier to log the user with the mapped tenant - see https://authress.io/app/#/manage?focus=tenants */
  tenantLookupIdentifier?: string;
  /** Specify where the provider should redirect the user to in your application. */
  redirectUrl?: string;
  /** Overrides the connection specific properties from the Authress Identity Connection to pass to the identity provider */
  connectionProperties?: Record<string, string>;
}

export interface UserProfile {
  /** List of Linked Identities for the user. */
  linkedIdentities: Array<LinkedIdentity>;
}

export interface LinkedIdentity {
  /** The linked identity originating identity provider user information. */
  connection: LinkedIdentityConnection;
}

export interface LinkedIdentityConnection {
  /** The linked identity provider connection ID. */
  connectionId: string;
  /** The user's user ID from the linked identity provider. */
  userId: string;
}

/** Options for getting a token including timeout configuration. */
export interface TokenParameters {
  /** Timeout in milliseconds waiting for a user token. After this time an error will be thrown. Use -1 for no timeout. (Default: **5000**) */
  timeoutInMillis?: number;
}

/** Decoded user identity from the Authress-issued ID token. */
export interface UserIdentity {
  /** The user's unique identifier. */
  userId: string;
  /** Token subject — same value as userId. */
  sub: string;
  /** Any additional claims present in the token. */
  [key: string]: unknown;
}

/** MFA device */
export interface Device {
  /** Unique Device ID for the this user specified MFA device. */
  deviceId: string;
  /** User specified name for this device. */
  name: string;
}

/** Token not available within the requested timeout. */
export class TokenTimeoutError extends Error {
  readonly code = 'TokenTimeoutError' as const;
  constructor() { super('Token not available within the requested timeout'); this.name = 'TokenTimeoutError'; }
}

/** The authentication flow was called with no pending request. */
export class NoAuthenticationRequestInProgressError extends Error {
  readonly code = 'NoAuthenticationRequestInProgressError' as const;
  constructor() { super('No authentication request is currently in progress'); this.name = 'NoAuthenticationRequestInProgressError'; }
}

/** The authentication flow was called with a mismatched authenticationRequestId. */
export class AuthenticationRequestMismatchError extends Error {
  readonly code = 'AuthenticationRequestMismatchError' as const;
  constructor() { super('Authentication request ID does not match the pending request'); this.name = 'AuthenticationRequestMismatchError'; }
}

/** Union of all authentication flow errors. */
export type AuthFlowError = NoAuthenticationRequestInProgressError | AuthenticationRequestMismatchError;

/** The requested operation requires the user to be logged in. */
export class NotLoggedInError extends Error {
  readonly code = 'NotLoggedInError' as const;
  constructor() { super('The requested operation requires the user to be logged in'); this.name = 'NotLoggedInError'; }
}

/** The requested operation was called with missing or invalid connection parameters. */
export class InvalidConnectionError extends Error {
  readonly code = 'InvalidConnectionError' as const;
  constructor() { super('connectionId or tenantLookupIdentifier is required'); this.name = 'InvalidConnectionError'; }
}
