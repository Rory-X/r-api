import { describe, expect, it } from 'vitest';
import {
  normalizeOauthCredentialImport,
  OauthCredentialImportFormatError,
} from './oauthCredentialImport.js';

describe('normalizeOauthCredentialImport', () => {
  it('normalizes a CPA auth-dir native OAuth object', () => {
    const result = normalizeOauthCredentialImport({
      type: 'codex',
      access_token: 'cpa-access',
      refresh_token: 'cpa-refresh',
      id_token: 'cpa-id',
      account_id: 'cpa-account',
      expired: '2026-08-24T03:44:53Z',
    });

    expect(result).toMatchObject({
      format: 'native',
      label: 'Codex OAuth JSON',
      issues: [],
      records: [{
        type: 'codex',
        access_token: 'cpa-access',
        refresh_token: 'cpa-refresh',
        id_token: 'cpa-id',
        account_id: 'cpa-account',
        expired: '2026-08-24T03:44:53Z',
      }],
    });
  });

  it('accepts a Cockpit bare array of native OAuth objects', () => {
    const result = normalizeOauthCredentialImport([{
      type: 'codex',
      access_token: 'cockpit-access',
      refresh_token: 'cockpit-refresh',
      email: 'cockpit@example.com',
    }]);

    expect(result.format).toBe('array');
    expect(result.label).toBe('OAuth 凭证数组');
    expect(result.records).toEqual([
      expect.objectContaining({
        type: 'codex',
        access_token: 'cockpit-access',
        refresh_token: 'cockpit-refresh',
        email: 'cockpit@example.com',
      }),
    ]);
  });

  it('infers an untyped Sub2API accounts envelope by structure', () => {
    const result = normalizeOauthCredentialImport({
      exported_at: '2026-08-14T12:02:19Z',
      proxies: [],
      accounts: [{
        name: 'Sub2 Codex',
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: 'sub2-access',
          refresh_token: 'sub2-refresh',
          chatgpt_account_id: 'sub2-account',
          expires_at: 1_787_543_093,
        },
      }, {
        name: 'Not an OAuth credential',
        platform: 'openai',
        type: 'apikey',
        credentials: { api_key: 'sk-ignored' },
      }],
    });

    expect(result.format).toBe('accounts-envelope');
    expect(result.label).toBe('Sub2API / Cockpit 包');
    expect(result.records).toEqual([
      expect.objectContaining({
        type: 'codex',
        access_token: 'sub2-access',
        refresh_token: 'sub2-refresh',
        account_id: 'sub2-account',
        expired: 1_787_543_093,
      }),
    ]);
  });

  it('accepts common data wrappers and camelCase token fields', () => {
    const result = normalizeOauthCredentialImport({
      data: {
        provider: 'openai',
        accessToken: 'wrapped-access',
        refreshToken: 'wrapped-refresh',
        accountId: 'wrapped-account',
        expiresAt: 1_800_000_000,
      },
    });

    expect(result.format).toBe('wrapped');
    expect(result.records).toEqual([
      expect.objectContaining({
        type: 'codex',
        access_token: 'wrapped-access',
        refresh_token: 'wrapped-refresh',
        account_id: 'wrapped-account',
        expired: 1_800_000_000,
      }),
    ]);
  });

  it('keeps valid entries when a mixed array contains invalid entries', () => {
    const result = normalizeOauthCredentialImport([
      { type: 'codex', access_token: 'valid-access' },
      { type: 'codex' },
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: '$[1]',
        message: '缺少 access_token/session_token',
      }),
    ]);
  });

  it('rejects payloads that contain no recognizable OAuth credential', () => {
    expect(() => normalizeOauthCredentialImport({ api_key: 'sk-not-oauth' }))
      .toThrow(OauthCredentialImportFormatError);
  });
});
