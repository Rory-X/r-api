import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type ActivationModule = typeof import('./browserCredentialActivationService.js');

describe('browser credential activation runtime', () => {
  let internals: ReturnType<ActivationModule['browserCaptureRuntimeInternals']>;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-browser-activation-'));
    await import('../db/migrate.js');
    const module = await import('./browserCredentialActivationService.js');
    internals = module.browserCaptureRuntimeInternals();
  });

  it('reads the versioned encrypted-capture payload without widening fields', () => {
    const capture = internals.parseCaptureSecret(JSON.stringify({
      version: 1,
      origin: 'https://example.com',
      fields: [
        { name: 'session_cookie', kind: 'cookie', value: 'sid=abc' },
        { name: 'user_id', kind: 'local_storage', value: '42' },
      ],
    }));

    expect(internals.readField(capture, 'session_cookie')).toBe('sid=abc');
    expect(internals.readPositiveInteger(capture, 'user_id')).toBe(42);
  });

  it('extracts a username from a JSON storage field', () => {
    const capture = internals.parseCaptureSecret(JSON.stringify({
      version: 1,
      origin: 'https://example.com',
      fields: [{ name: 'auth_user', kind: 'local_storage', value: '{"username":"alice"}' }],
    }));

    expect(internals.readUsername(capture, {
      kind: 'session_token',
      field: 'auth_token',
      usernameField: 'auth_user',
    })).toBe('alice');
  });

  it('rejects malformed capture payloads', () => {
    expect(() => internals.parseCaptureSecret('{"version":2}')).toThrow('格式不受支持');
  });
});
