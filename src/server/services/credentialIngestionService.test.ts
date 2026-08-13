import { describe, expect, it } from 'vitest';
import {
  buildCredentialBatchPreview,
  detectCredentialFormat,
  normalizeCredentialInput,
  toCredentialPreview,
  validateCredentialCandidate,
} from './credentialIngestionService.js';

describe('credentialIngestionService', () => {
  it('normalizes native OAuth JSON into an OAuth token-set candidate', () => {
    const result = normalizeCredentialInput({
      type: 'openai',
      access_token: 'oauth-access-secret',
      refresh_token: 'oauth-refresh-secret',
      id_token: 'oauth-id-secret',
      expired: 1_800_000_000,
      email: 'alice@example.com',
      account_id: 'acct-1',
    });

    expect(result.detection).toMatchObject({
      format: 'native_oauth_json',
      provider: 'codex',
      confidence: 'high',
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      provider: 'codex',
      kind: 'oauth_token_set',
      identity: {
        externalId: 'acct-1',
        email: 'alice@example.com',
      },
      secretPresence: {
        accessToken: true,
        refreshToken: true,
        idToken: true,
      },
      expiresAt: 1_800_000_000_000,
      compatibleTargets: ['native_oauth', 'vault'],
    });
  });

  it('expands a Sub2API bundle into independently promotable candidates', () => {
    const result = normalizeCredentialInput({
      type: 'sub2api-bundle',
      version: 1,
      accounts: [
        {
          account_id: 'sub-1',
          auth_token: 'sub-access-1',
          refresh_token: 'sub-refresh-1',
          token_expires_at: 1_900_000_000_000,
        },
        {
          account_id: 'sub-2',
          access_token: 'sub-access-2',
          refresh_token: 'sub-refresh-2',
        },
      ],
    });

    expect(result.detection).toMatchObject({
      format: 'sub2api_bundle',
      provider: 'sub2api',
      isBatch: true,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      provider: 'sub2api',
      kind: 'oauth_token_set',
      source: { format: 'sub2api_bundle', sourceIndex: 0 },
      identity: { externalId: 'sub-1' },
      secretPresence: { accessToken: true, refreshToken: true },
      compatibleTargets: ['sub2api', 'vault'],
    });
  });

  it('distinguishes NewAPI password, session, and API-key credentials', () => {
    const password = normalizeCredentialInput({
      type: 'new_api',
      username: 'alice',
      password: 'password-secret',
    }).candidates[0];
    const session = normalizeCredentialInput({
      platform: 'one-api',
      username: 'bob',
      access_token: 'session-secret',
    }).candidates[0];
    const apiKey = normalizeCredentialInput({
      provider: 'newapi',
      api_key: 'sk-new-api-secret',
    }).candidates[0];

    expect(password).toMatchObject({
      kind: 'username_password',
      secretPresence: { password: true },
      compatibleTargets: ['new_api'],
    });
    expect(session).toMatchObject({
      kind: 'session_token',
      secretPresence: { accessToken: true },
      compatibleTargets: ['new_api', 'vault'],
    });
    expect(apiKey).toMatchObject({
      kind: 'api_key',
      secretPresence: { apiKey: true },
      compatibleTargets: ['new_api', 'api_key', 'vault'],
    });
  });

  it('normalizes plain and mixed-batch API keys', () => {
    expect(detectCredentialFormat('sk-plain-secret')).toMatchObject({
      format: 'api_key',
      confidence: 'medium',
    });

    const single = normalizeCredentialInput('sk-plain-secret').candidates[0];
    const batch = normalizeCredentialInput([
      'sk-first-secret',
      { api_key: 'sk-second-secret', name: 'second' },
    ]);

    expect(single).toMatchObject({
      kind: 'api_key',
      secretPresence: { apiKey: true },
      compatibleTargets: ['api_key', 'new_api', 'sub2api', 'vault'],
    });
    expect(batch.detection.format).toBe('mixed_batch');
    expect(batch.candidates).toHaveLength(2);
    expect(batch.candidates.map((candidate) => candidate.kind)).toEqual(['api_key', 'api_key']);

    const opaque = normalizeCredentialInput('opaque-provider-token').candidates[0];
    expect(opaque).toMatchObject({
      kind: 'api_key',
      secretPresence: { apiKey: true },
      warnings: expect.arrayContaining([
        '纯文本凭证格式不明确，将按 API Key 候选交由目标站点验证',
      ]),
    });
  });

  it('unwraps Cockpit account-transfer payloads and marks metadata-only entries', () => {
    const result = normalizeCredentialInput({
      schema: 'cockpit-tools.account-transfer',
      version: 1,
      platforms: {
        codex: {
          account_count: 1,
          exported_data: [{
            type: 'codex',
            email: 'codex@example.com',
            access_token: 'codex-access-secret',
            refresh_token: 'codex-refresh-secret',
          }],
        },
        grok: {
          account_count: 1,
          exported_data: [{ email: 'grok@example.com', plan: 'pro' }],
        },
      },
    });

    expect(result.detection).toMatchObject({
      format: 'cockpit_account_transfer',
      version: 1,
      isBatch: true,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      source: { format: 'cockpit_platform_payload', platform: 'codex' },
      provider: 'codex',
      kind: 'oauth_token_set',
      compatibleTargets: ['native_oauth', 'vault'],
    });
    expect(result.candidates[1]).toMatchObject({
      source: { format: 'cockpit_platform_payload', platform: 'grok' },
      provider: 'grok',
      kind: 'metadata_only',
      compatibleTargets: [],
    });
    expect(result.candidates[1]?.warnings).toContain(
      '该条目只有元数据，不能恢复登录或创建可路由凭证',
    );
  });

  it('produces stable fingerprints without exposing secrets in previews', () => {
    const first = normalizeCredentialInput({
      type: 'codex',
      access_token: 'preview-access-secret',
      refresh_token: 'preview-refresh-secret',
    }).candidates[0];
    const same = normalizeCredentialInput({
      type: 'codex',
      access_token: 'rotated-access-secret',
      refresh_token: 'preview-refresh-secret',
    }).candidates[0];
    const different = normalizeCredentialInput({
      type: 'codex',
      access_token: 'preview-access-secret',
      refresh_token: 'different-refresh-secret',
    }).candidates[0];
    const preview = toCredentialPreview(first);

    expect(first.fingerprint).toBe(same.fingerprint);
    expect(first.fingerprint).not.toBe(different.fingerprint);
    expect(preview).not.toHaveProperty('secrets');
    expect(JSON.stringify(preview)).not.toContain('preview-access-secret');
    expect(JSON.stringify(preview)).not.toContain('preview-refresh-secret');
    expect(preview.secretSummary).toEqual(first.secretPresence);
  });

  it('validates target compatibility and credential lifecycle readiness', () => {
    const sub2api = normalizeCredentialInput({
      type: 'sub2api-data',
      access_token: 'expired-access',
      refresh_token: 'refresh-available',
      token_expires_at: '2026-08-01T00:00:00.000Z',
    }).candidates[0];
    const noRefresh = normalizeCredentialInput({
      type: 'sub2api-data',
      access_token: 'expired-without-refresh',
      token_expires_at: '2026-08-01T00:00:00.000Z',
    }).candidates[0];

    expect(validateCredentialCandidate(sub2api, 'sub2api', Date.parse('2026-08-13T00:00:00.000Z')))
      .toMatchObject({
        status: 'ready',
        target: 'sub2api',
        errors: [],
        warnings: expect.arrayContaining(['Access token 已过期，执行导入时需要先刷新']),
      });
    expect(validateCredentialCandidate(sub2api, 'native_oauth')).toMatchObject({
      status: 'incomplete',
      errors: expect.arrayContaining(['凭证类型 oauth_token_set 不兼容目标 native_oauth']),
    });
    expect(validateCredentialCandidate(noRefresh, 'sub2api', Date.parse('2026-08-13T00:00:00.000Z')))
      .toMatchObject({
        status: 'incomplete',
        errors: expect.arrayContaining(['凭证已过期且没有 refresh token']),
        warnings: expect.arrayContaining(['缺少 refresh token，导入后不能使用托管刷新']),
      });
  });

  it('detects browser credentials and limits them to the Vault target', () => {
    const result = normalizeCredentialInput({
      provider: 'new-api',
      username: 'browser-user',
      cookie: 'session=browser-secret',
    });

    expect(result.detection.format).toBe('browser_storage');
    expect(result.candidates[0]).toMatchObject({
      provider: 'new-api',
      kind: 'browser_storage',
      secretPresence: { cookie: true },
      compatibleTargets: ['vault'],
    });
    expect(validateCredentialCandidate(result.candidates[0], 'new_api')).toMatchObject({
      status: 'incomplete',
      errors: ['凭证类型 browser_storage 不兼容目标 new_api'],
    });
  });

  it('marks batch duplicates and builds an order-independent idempotency fingerprint', () => {
    const first = normalizeCredentialInput('sk-duplicate-secret').candidates[0];
    const second = normalizeCredentialInput({ api_key: 'sk-unique-secret' }).candidates[0];

    const preview = buildCredentialBatchPreview([first, second, first], 'api_key');
    const reordered = buildCredentialBatchPreview([second, first, first], 'api_key');

    expect(preview.duplicateCount).toBe(1);
    expect(preview.candidates[2]).toMatchObject({ duplicateOfIndex: 0 });
    expect(preview.batchFingerprint).toBe(reordered.batchFingerprint);
    expect(preview.batchFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the execution fingerprint when identity or lifecycle fields change', () => {
    const base = normalizeCredentialInput({
      type: 'codex',
      access_token: 'same-access-token',
      refresh_token: 'same-refresh-token',
      email: 'first@example.com',
      expired: '2026-09-01T00:00:00.000Z',
    }).candidates;
    const changedIdentity = normalizeCredentialInput({
      type: 'codex',
      access_token: 'same-access-token',
      refresh_token: 'same-refresh-token',
      email: 'second@example.com',
      expired: '2026-09-01T00:00:00.000Z',
    }).candidates;
    const changedExpiry = normalizeCredentialInput({
      type: 'codex',
      access_token: 'same-access-token',
      refresh_token: 'same-refresh-token',
      email: 'first@example.com',
      expired: '2026-10-01T00:00:00.000Z',
    }).candidates;

    const baseFingerprint = buildCredentialBatchPreview(base, 'native_oauth').batchFingerprint;
    expect(buildCredentialBatchPreview(changedIdentity, 'native_oauth').batchFingerprint)
      .not.toBe(baseFingerprint);
    expect(buildCredentialBatchPreview(changedExpiry, 'native_oauth').batchFingerprint)
      .not.toBe(baseFingerprint);
  });
});
