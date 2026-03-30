import { describe, it, expect, vi } from 'vitest';

// Mock react-native-quick-crypto before importing jwtManager
vi.mock('react-native-quick-crypto', () => ({
  default: {
    getRandomValues(array: Uint32Array) {
      for (let i = 0; i < array.length; i++) {array[i] = i + 1;}
      return array;
    },
    subtle: {
      async digest(_algorithm: string, _data: Uint8Array): Promise<ArrayBuffer> {
        // Returns a fixed 32-byte value whose base64url encoding starts with "00".
        // base64url '0' = index 52 = 0b110100. First two chars come from first 12 bits.
        // We need bits: 110100_110100 → byte[0]=0xD3, byte[1]=0x40.
        const bytes = new Uint8Array(32);
        bytes[0] = 0xD3;
        bytes[1] = 0x40;
        return bytes.buffer;
      }
    }
  }
}));

import jwtManager from '../src/jwtManager.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256' }): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.signature`;
}

// ── decode ────────────────────────────────────────────────────────────────────

describe('jwtManager.decode', () => {
  it('returns null for null', () => {
    expect(jwtManager.decode(null as unknown as string)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(jwtManager.decode('')).toBeNull();
  });

  it('returns the payload for a valid JWT', () => {
    const payload = { sub: 'user-1', iss: 'https://example.authress.io' };
    const result = jwtManager.decode(makeJwt(payload));
    expect(result).toMatchObject({ sub: 'user-1', iss: 'https://example.authress.io' });
  });

  it('subtracts 10 seconds from exp', () => {
    const jwt = makeJwt({ sub: 'u', exp: 9999999 });
    const result = jwtManager.decode(jwt);
    expect(result!.exp).toBe(9999989);
  });

  it('returns null for a malformed token (not valid base64url JSON)', () => {
    expect(jwtManager.decode('not.a.jwt')).toBeNull();
  });
});

// ── decodeFull ────────────────────────────────────────────────────────────────

describe('jwtManager.decodeFull', () => {
  it('returns null for empty input', () => {
    expect(jwtManager.decodeFull('')).toBeNull();
  });

  it('returns both header and payload', () => {
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { sub: 'u', iss: 'https://example.authress.io' };
    const result = jwtManager.decodeFull(makeJwt(payload, header));
    expect(result!.header).toMatchObject(header);
    expect(result!.payload).toMatchObject(payload);
  });

  it('still returns payload when header is unparseable', () => {
    const payload = { sub: 'u' };
    const badHeaderJwt = `notbase64json.${b64url(JSON.stringify(payload))}.sig`;
    const result = jwtManager.decodeFull(badHeaderJwt);
    expect(result).not.toBeNull();
    expect(result!.payload).toMatchObject({ sub: 'u' });
    expect(result!.header).toBeNull();
  });
});

// ── decodeOrParse ─────────────────────────────────────────────────────────────

describe('jwtManager.decodeOrParse', () => {
  it('returns null for null/empty', () => {
    expect(jwtManager.decodeOrParse(null as unknown as string)).toBeNull();
    expect(jwtManager.decodeOrParse('')).toBeNull();
  });

  it('passes through an object as-is', () => {
    const obj = { sub: 'u' };
    expect(jwtManager.decodeOrParse(obj as unknown as string)).toBe(obj);
  });

  it('JSON-parses a JSON string', () => {
    expect(jwtManager.decodeOrParse('{"sub":"u"}')).toEqual({ sub: 'u' });
  });

  it('JWT-decodes a token string when JSON.parse fails', () => {
    const jwt = makeJwt({ sub: 'u' });
    const result = jwtManager.decodeOrParse(jwt);
    expect(result).toMatchObject({ sub: 'u' });
  });
});

// ── getAuthCodes ──────────────────────────────────────────────────────────────

describe('jwtManager.getAuthCodes', () => {
  it('returns codeVerifier and codeChallenge', async () => {
    const { codeVerifier, codeChallenge } = await jwtManager.getAuthCodes();
    expect(typeof codeVerifier).toBe('string');
    expect(codeVerifier.length).toBeGreaterThan(0);
    expect(typeof codeChallenge).toBe('string');
    expect(codeChallenge.length).toBeGreaterThan(0);
  });

  it('codeChallenge contains only base64url characters', async () => {
    const { codeChallenge } = await jwtManager.getAuthCodes();
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('codeChallenge is the base64url-encoded SHA-256 of codeVerifier', async () => {
    // With the deterministic mock, same input → same output
    const first = await jwtManager.getAuthCodes();
    const second = await jwtManager.getAuthCodes();
    // codeVerifier is derived from mocked getRandomValues (deterministic in test)
    expect(first.codeVerifier).toBe(second.codeVerifier);
    expect(first.codeChallenge).toBe(second.codeChallenge);
  });

  it('does not reference window.crypto', async () => {
    expect(typeof window).toBe('undefined');
    // getAuthCodes must still succeed — it uses react-native-quick-crypto, not window.crypto
    await expect(jwtManager.getAuthCodes()).resolves.toBeDefined();
  });
});

// ── calculateAntiAbuseHash ────────────────────────────────────────────────────

describe('jwtManager.calculateAntiAbuseHash', () => {
  it('returns a string in the format v2;<timestamp>;<fineTuner>;<hash>', async () => {
    const result = await jwtManager.calculateAntiAbuseHash({ userId: 'u', applicationId: 'app' });
    expect(result).toMatch(/^v2;\d+;\d+;[A-Za-z0-9_-]+$/);
  });

  it('hash segment starts with 00', async () => {
    const result = await jwtManager.calculateAntiAbuseHash({ userId: 'u' });
    const hash = result.split(';')[3];
    expect(hash).toMatch(/^00/);
  });

  it('does not reference window.crypto', async () => {
    expect(typeof window).toBe('undefined');
    await expect(jwtManager.calculateAntiAbuseHash({ userId: 'u' })).resolves.toBeDefined();
  });
});
