import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: vi.fn().mockResolvedValue(text)
  };
}

import HttpClient from '../src/httpClient.ts';

const BASE_URL = 'https://my-app.login.authress.io';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── constructor ───────────────────────────────────────────────────────────────

describe('HttpClient constructor', () => {
  it('throws when authressApiUrl is missing', () => {
    expect(() => new HttpClient('', console)).toThrow();
  });

  it('constructs without throwing for a valid URL', () => {
    expect(() => new HttpClient(BASE_URL, console)).not.toThrow();
  });
});

// ── credentials ───────────────────────────────────────────────────────────────

describe('HttpClient — credentials', () => {
  it('always sends credentials: include on GET', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.get('/authentication');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('always sends credentials: include on POST', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.post('/authentication', { foo: 'bar' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' })
    );
  });
});

// ── headers ───────────────────────────────────────────────────────────────────

describe('HttpClient — headers', () => {
  it('sends Content-Type: application/json', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.get('/authentication');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sends X-Powered-By header', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.get('/authentication');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Powered-By']).toMatch(/Authress/);
  });

  it('merges extra headers passed by caller', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.get('/authentication', { Authorization: 'Bearer token' });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer token');
  });
});

// ── URL construction ──────────────────────────────────────────────────────────

describe('HttpClient — URL', () => {
  it('prepends /api to the path', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.get('/authentication');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://my-app.login.authress.io/api/authentication');
  });
});

// ── HTTP methods ──────────────────────────────────────────────────────────────

describe('HttpClient — methods', () => {
  it('GET sends no body', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.get('/authentication');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('POST serializes body as JSON', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.post('/authentication', { code: 'abc' });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ code: 'abc' }));
  });

  it('PATCH serializes body as JSON', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.patch('/session', { key: 'val' });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ key: 'val' }));
  });

  it('DELETE sends no body', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.delete('/session');
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('PUT serializes body as JSON', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    await client.put('/resource', { x: 1 });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ x: 1 }));
  });
});

// ── response handling ─────────────────────────────────────────────────────────

describe('HttpClient — response handling', () => {
  it('returns parsed JSON response body', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { userId: 'u1' }));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data).toEqual({ userId: 'u1' });
  });

  it('returns raw text when response body is not JSON', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, 'not json'));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data).toBe('not json');
  });

  it('returns Err on 4xx response', async () => {
    mockFetch.mockResolvedValue(makeResponse(401, { message: 'Unauthorized' }, false));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 401 });
  });

  it('returns Err on 404 response', async () => {
    mockFetch.mockResolvedValue(makeResponse(404, { message: 'Not Found' }, false));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 404 });
  });

  it('includes url, method, status, and data in error', async () => {
    mockFetch.mockResolvedValue(makeResponse(403, { message: 'Forbidden' }, false));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 403, method: 'GET', data: { message: 'Forbidden' } });
  });
});

// ── retry ─────────────────────────────────────────────────────────────────────

describe('HttpClient — retry', () => {
  it('retries on network error and eventually succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValue(makeResponse(200, { ok: true }));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns Err after 5 network failures', async () => {
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ data: expect.stringContaining('Network Error') });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('does not retry on 4xx errors', async () => {
    mockFetch.mockResolvedValue(makeResponse(400, { message: 'Bad Request' }, false));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isErr()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 5xx errors', async () => {
    mockFetch.mockResolvedValue(makeResponse(500, 'Server Error', false));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isErr()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── no browser globals ────────────────────────────────────────────────────────

describe('HttpClient — no browser globals', () => {
  it('does not reference window', async () => {
    expect(typeof window).toBe('undefined');
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const client = new HttpClient(BASE_URL, console);
    const result = await client.get('/authentication');
    expect(result.isOk()).toBe(true);
  });
});
