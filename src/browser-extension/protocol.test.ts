import { describe, expect, it } from 'vitest';
import {
  buildCompletionFields,
  isOriginAllowed,
  parseRecoveryLaunchUrl,
  validateRecoveryTask,
} from './protocol.js';

describe('browser recovery extension protocol', () => {
  it('accepts HTTPS and loopback launch URLs but rejects remote HTTP', () => {
    expect(parseRecoveryLaunchUrl(
      'https://gateway.example/browser-credential-recovery#task=task-1&token=abcdefghijklmnopqrstuvwxyzABCDEF123456',
    )).toMatchObject({ serverUrl: 'https://gateway.example', taskId: 'task-1' });
    expect(parseRecoveryLaunchUrl(
      'http://127.0.0.1:4000/browser-credential-recovery#task=task-1&token=abcdefghijklmnopqrstuvwxyzABCDEF123456',
    ).serverUrl).toBe('http://127.0.0.1:4000');
    expect(() => parseRecoveryLaunchUrl(
      'http://gateway.example/browser-credential-recovery#task=task-1&token=abcdefghijklmnopqrstuvwxyzABCDEF123456',
    )).toThrow('HTTPS');
  });

  it('validates exact and wildcard origins without accepting the parent domain', () => {
    expect(isOriginAllowed('https://api.example.com', ['https://api.example.com'])).toBe(true);
    expect(isOriginAllowed('https://a.example.com', ['https://*.example.com'])).toBe(true);
    expect(isOriginAllowed('https://example.com', ['https://*.example.com'])).toBe(false);
  });

  it('keeps completion values inside the declared field allowlist', () => {
    const fields = [
      { name: 'session_cookie', kind: 'cookie' as const, required: true },
      { name: 'user_id', kind: 'local_storage' as const, required: false },
    ];
    expect(buildCompletionFields(fields, {
      session_cookie: 'session=abc',
      user_id: '42',
      full_profile: 'forbidden',
    })).toEqual([
      { name: 'session_cookie', kind: 'cookie', value: 'session=abc' },
      { name: 'user_id', kind: 'local_storage', value: '42' },
    ]);
    expect(() => buildCompletionFields(fields, {})).toThrow('session_cookie');
  });

  it('rejects executable or wildcard-like task fields', () => {
    const base = {
      id: 'task-1',
      mode: 'assisted',
      status: 'claimed',
      credentialName: 'session',
      adapterPlatform: 'new-api',
      targetUrl: 'https://api.example.com/login',
      targetOrigin: 'https://api.example.com',
      allowedOrigins: ['https://api.example.com'],
      fields: [{ name: '*', kind: 'local_storage', required: true }],
      requiresUserGesture: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(() => validateRecoveryTask(base, 'task-1')).toThrow('字段白名单');
  });
});
