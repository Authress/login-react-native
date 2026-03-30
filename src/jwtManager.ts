import { toBase64, fromBase64 } from 'js-base64';
import crypto from 'react-native-quick-crypto';

function b64urlEncode(input: string | ArrayBuffer | Uint8Array): string {
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    return toBase64(new Uint8Array(input instanceof ArrayBuffer ? input : input.buffer), true);
  }
  return toBase64(input, true);
}

function b64urlDecode(input: string): string {
  return fromBase64(input);
}

interface JwtPayload {
  exp?: number;
  [key: string]: unknown;
}

interface DecodedJwt {
  header: Record<string, unknown> | null;
  payload: JwtPayload;
}

class JwtManager {
  decode(token: string): JwtPayload | null {
    if (!token) {
      return null;
    }
    return this.decodeFull(token)?.payload ?? null;
  }

  decodeOrParse(token: string | object): JwtPayload | object | null {
    if (!token) {
      return null;
    }
    if (typeof token === 'object') {
      return token;
    }
    try {
      return JSON.parse(token);
    } catch (_) {
      return this.decode(token);
    }
  }

  decodeFull(token: string): DecodedJwt | null {
    if (!token) {
      return null;
    }

    let header: Record<string, unknown> | null = null;
    try {
      header = JSON.parse(b64urlDecode(token.split('.')[0]));
    } catch (_) {
      // Header errors are non-fatal
    }

    try {
      const payload: JwtPayload = JSON.parse(b64urlDecode(token.split('.')[1]));
      if (payload.exp) {
        payload.exp = payload.exp - 10;
      }
      return { header, payload };
    } catch (_) {
      return null;
    }
  }

  async getAuthCodes(): Promise<{ codeVerifier: string; codeChallenge: string }> {
    const codeVerifier = b64urlEncode(crypto.getRandomValues(new Uint32Array(16)).toString());
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = b64urlEncode(hashBuffer);
    return { codeVerifier, codeChallenge };
  }

  async calculateAntiAbuseHash(props: Record<string, unknown>): Promise<string> {
    const timestamp = Date.now();
    const valueString = Object.values(props)
      .filter(v => v)
      .map(v => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          return v;
        }
        return Object.keys(v as object).sort((a, b) => a.localeCompare(b)).map(key => (v as Record<string, unknown>)[key]).join('-');
      })
      .join('|');

    let fineTuner = 0;
    while (++fineTuner) {
      const hash = b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${timestamp};${fineTuner};${valueString}`)));
      if (hash.match(/^00/)) {
        return `v2;${timestamp};${fineTuner};${hash}`;
      }
    }

    throw new Error('HashFailed');
  }
}

export default new JwtManager();
