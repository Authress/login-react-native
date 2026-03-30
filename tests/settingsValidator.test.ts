import { describe, it, expect } from 'vitest';
import { validateSettings, sanitizeUrl } from '../src/settingsValidator.ts';

const validSettings = {
  authressApiUrl: 'https://my-app.login.authress.io',
  applicationId: 'app_123',
  redirectUri: 'myapp://callback'
};

describe('validateSettings', () => {
  it('returns normalized settings for valid input', () => {
    const result = validateSettings(validSettings);
    expect(result.authressApiUrl).toBe('https://my-app.login.authress.io');
    expect(result.applicationId).toBe('app_123');
    expect(result.redirectUri).toBe('myapp://callback');
  });

  it('throws when authressApiUrl is missing', () => {
    expect(() => validateSettings({ ...validSettings, authressApiUrl: '' })).toThrow();
  });

  it('throws when applicationId is missing', () => {
    expect(() => validateSettings({ ...validSettings, applicationId: '' })).toThrow();
  });

  it('throws when applicationId is whitespace only', () => {
    expect(() => validateSettings({ ...validSettings, applicationId: '   ' })).toThrow();
  });

  it('throws when applicationId starts with sc_', () => {
    expect(() => validateSettings({ ...validSettings, applicationId: 'sc_abc123' })).toThrow(/service client/i);
  });

  it('throws when applicationId starts with ext_', () => {
    expect(() => validateSettings({ ...validSettings, applicationId: 'ext_abc123' })).toThrow(/service client/i);
  });

  it('throws when redirectUri is missing', () => {
    expect(() => validateSettings({ ...validSettings, redirectUri: '' })).toThrow();
  });

  it('sanitizes authressApiUrl (strips trailing slash)', () => {
    const result = validateSettings({ ...validSettings, authressApiUrl: 'https://my-app.login.authress.io/' });
    expect(result.authressApiUrl).toBe('https://my-app.login.authress.io');
  });

  it('sanitizes authressApiUrl (rewrites subdomain)', () => {
    const result = validateSettings({ ...validSettings, authressApiUrl: 'https://my-app.api.authress.io' });
    expect(result.authressApiUrl).toBe('https://my-app.login.authress.io');
  });

  it('sanitizes authressApiUrl (prepends https when scheme missing)', () => {
    const result = validateSettings({ ...validSettings, authressApiUrl: 'my-app.login.authress.io' });
    expect(result.authressApiUrl).toBe('https://my-app.login.authress.io');
  });

  it('trims applicationId whitespace', () => {
    const result = validateSettings({ ...validSettings, applicationId: '  app_123  ' });
    expect(result.applicationId).toBe('app_123');
  });
});

describe('sanitizeUrl', () => {
  it('passes through a clean URL', () => {
    expect(sanitizeUrl('https://my-app.login.authress.io')).toBe('https://my-app.login.authress.io');
  });

  it('prepends https when scheme is missing', () => {
    expect(sanitizeUrl('my-app.login.authress.io')).toBe('https://my-app.login.authress.io');
  });

  it('strips trailing slashes', () => {
    expect(sanitizeUrl('https://my-app.login.authress.io///')).toBe('https://my-app.login.authress.io');
  });

  it('rewrites <subdomain>.<anything>.authress.io to login subdomain', () => {
    expect(sanitizeUrl('https://my-app.api.authress.io')).toBe('https://my-app.login.authress.io');
  });
});
