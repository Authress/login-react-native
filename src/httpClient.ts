import { Result, ResultAsync, ok, err } from 'neverthrow';
import packageInfo from '../package.json' with { type: 'json' };

const defaultHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Powered-By': `Authress Login SDK; React Native; ${packageInfo.version}`
};

export interface HttpResponse<T = unknown> {
  url: string;
  method: string;
  status: number;
  headers: Headers;
  data: T;
}

/** Network or connectivity failure — the request never reached the Authress service. */
export interface AuthressHttpNetworkError {
  name: 'AuthressHttpNetworkError';
  url: string;
  method: string;
  data: string;
}

/** The Authress service responded with a 4xx status — the client sent a bad request. */
export interface AuthressHttpClientError {
  name: 'AuthressHttpClientError';
  url: string;
  method: string;
  status: number;
  data: unknown;
  headers: Headers;
}

/** The Authress service responded with a 5xx status — the service encountered an error. */
export interface AuthressHttpServiceError {
  name: 'AuthressHttpServiceError';
  url: string;
  method: string;
  status: number;
  data: unknown;
  headers: Headers;
}

/** Any HTTP-level error — network failure, client error (4xx), or service error (5xx). */
export type AuthressHttpError = AuthressHttpNetworkError | AuthressHttpClientError | AuthressHttpServiceError;

export interface Logger {
  debug(...args: unknown[]): void; // eslint-disable-line no-unused-vars
  log(...args: unknown[]): void; // eslint-disable-line no-unused-vars
  warn(...args: unknown[]): void; // eslint-disable-line no-unused-vars
  error(...args: unknown[]): void; // eslint-disable-line no-unused-vars
}

function retryExecutor<T>(func: () => Promise<Result<T, AuthressHttpError>>): ResultAsync<T, AuthressHttpError> {
  return new ResultAsync(
    (async (): Promise<Result<T, AuthressHttpError>> => {
      let lastNetworkError: AuthressHttpNetworkError | null = null;
      for (let iteration = 0; iteration < 5; iteration++) {
        const result = await func();
        if (result.isOk()) {
          return result;
        }

        if (result.error.name !== 'AuthressHttpNetworkError') {
          return result; // 4xx or 5xx — don't retry
        }

        lastNetworkError = result.error;
        await new Promise<void>(resolve => setTimeout(resolve, 10 * 2 ** iteration));
      }
      return err<AuthressHttpNetworkError>({ ...lastNetworkError!, name: 'AuthressHttpNetworkError', data: '[Authress Login SDK] Http Request failed due to a Network Error even after multiple retries' });
    })()
  );
}

class HttpClient {
  private readonly loginUrl: string;
  private readonly logger: Logger;

  constructor(authressApiUrl: string, logger: Logger) {
    if (!authressApiUrl) {
      throw new Error('Custom Authress Domain Host is required');
    }

    this.logger = logger;
    const loginHostFullUrl = new URL(authressApiUrl);
    this.loginUrl = `${loginHostFullUrl.origin}/api`;
  }

  get<T = unknown>(path: string, headers?: Record<string, string>, ignoreExpectedWarnings?: boolean): ResultAsync<HttpResponse<T>, AuthressHttpError> {
    return retryExecutor(() => this.fetchWrapper<T>('GET', path, undefined, headers, ignoreExpectedWarnings));
  }

  delete<T = unknown>(path: string, headers?: Record<string, string>, ignoreExpectedWarnings?: boolean): ResultAsync<HttpResponse<T>, AuthressHttpError> {
    return retryExecutor(() => this.fetchWrapper<T>('DELETE', path, undefined, headers, ignoreExpectedWarnings));
  }

  post<T = unknown>(path: string, data?: unknown, headers?: Record<string, string>, ignoreExpectedWarnings?: boolean): ResultAsync<HttpResponse<T>, AuthressHttpError> {
    return retryExecutor(() => this.fetchWrapper<T>('POST', path, data, headers, ignoreExpectedWarnings));
  }

  put<T = unknown>(path: string, data?: unknown, headers?: Record<string, string>, ignoreExpectedWarnings?: boolean): ResultAsync<HttpResponse<T>, AuthressHttpError> {
    return retryExecutor(() => this.fetchWrapper<T>('PUT', path, data, headers, ignoreExpectedWarnings));
  }

  patch<T = unknown>(path: string, data?: unknown, headers?: Record<string, string>, ignoreExpectedWarnings?: boolean): ResultAsync<HttpResponse<T>, AuthressHttpError> {
    return retryExecutor(() => this.fetchWrapper<T>('PATCH', path, data, headers, ignoreExpectedWarnings));
  }

  private async fetchWrapper<T = unknown>(rawMethod: string, path: string, data: unknown, requestHeaders?: Record<string, string>, ignoreExpectedWarnings?: boolean):
    Promise<Result<HttpResponse<T>, AuthressHttpError>> {
    const url = `${this.loginUrl}${path}`;
    const method = rawMethod.toUpperCase();
    const headers = Object.assign({}, defaultHeaders, requestHeaders);

    this.logger.debug({ title: '[Authress Login SDK] HttpClient Request', method, url });

    let response: Response;
    try {
      const init: RequestInit = { method, headers, credentials: 'include' };
      if (data !== undefined) {
        init.body = JSON.stringify(data);
      }
      response = await fetch(url, init);
    } catch (error: unknown) {
      return err<AuthressHttpNetworkError>({ name: 'AuthressHttpNetworkError', url, method, data: (error as Error)?.message ?? '' });
    }

    if (!response.ok) {
      let resolvedError: unknown = {};
      try {
        resolvedError = await response.text();
        resolvedError = JSON.parse(resolvedError as string);
      } catch (_) {
        /* non-JSON response — resolvedError remains the raw text string */
      }

      const status = response.status;
      let level: 'debug' | 'warn' = 'warn';
      if (status === 401 || status === 404) {
        level = 'debug';
      } else if (status < 500 && ignoreExpectedWarnings) {
        level = 'debug';
      }

      this.logger[level]({ title: '[Authress Login SDK] HttpClient Response Error', method, url, status, data, headers, error: resolvedError });
      return status >= 500
        ? err<AuthressHttpServiceError>({ name: 'AuthressHttpServiceError', url, method, status, data: resolvedError, headers: response.headers })
        : err<AuthressHttpClientError>({ name: 'AuthressHttpClientError', url, method, status, data: resolvedError, headers: response.headers });
    }

    let responseBody: unknown = {};
    try {
      responseBody = await response.text();
      responseBody = JSON.parse(responseBody as string);
    } catch (_) {
      /* non-JSON response — responseBody remains the raw text string */
    }

    return ok({ url, method, status: response.status, headers: response.headers, data: responseBody as T });
  }
}

export default HttpClient;
