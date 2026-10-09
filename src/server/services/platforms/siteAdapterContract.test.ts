import { describe, expect, it } from 'vitest';
import {
  getSiteAdapterContract,
  listSiteAdapterContracts,
  validateSiteAdapterContract,
} from './siteAdapterContract.js';

describe('site adapter capability contract', () => {
  it('limits OrcaRouter to API-key discovery and proxy capabilities', () => {
    const contract = getSiteAdapterContract('orcarouter');
    expect(contract.credentialKinds).toEqual(['api_key']);
    expect(contract.operations).toMatchObject({ models: true, verify_token: true, login: false, balance: false, checkin: false, api_tokens: false, announcements: false });
    expect(contract.browser.supported).toBe(false);
    expect(contract.checkin.allowsAutomaticExecution).toBe(false);
    expect(validateSiteAdapterContract(contract)).toEqual([]);
  });

  it('keeps every registered contract structurally valid', () => {
    const contracts = listSiteAdapterContracts();

    expect(contracts.length).toBeGreaterThan(5);
    for (const contract of contracts) {
      expect(validateSiteAdapterContract(contract)).toEqual([]);
      expect(contract.credentialStorage).toBe('encrypted_vault_only');
      expect(contract.modelSync.readOnly).toBe(true);
      expect(contract.modelSync.retireMissingAfterConsecutiveRuns).toBeGreaterThan(0);
    }
  });

  it('declares browser capture as an allowlist rather than a full profile export', () => {
    const contract = getSiteAdapterContract('new-api');

    expect(contract.browser).toMatchObject({
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      requiresUserGesture: true,
    });
    expect(contract.browser.fields).toEqual([
      { name: 'session_cookie', kind: 'cookie', required: true },
      {
        name: 'user_id',
        kind: 'local_storage',
        required: false,
        capture: { strategy: 'json_path', key: 'user', path: ['id'] },
      },
    ]);
    expect(contract.browser.fields.some((field) => field.name === '*')).toBe(false);
  });

  it('keeps Sub2API browser auth extraction declarative and field-scoped', () => {
    const contract = getSiteAdapterContract('sub2api');

    expect(contract.browser.fields.map((field) => field.name)).toEqual([
      'auth_token',
      'auth_user',
      'refresh_token',
      'token_expires_at',
    ]);
    expect(contract.browser.fields.every((field) => field.capture?.strategy === 'storage_value')).toBe(true);
    expect(contract.browser.fields.some((field) => field.name === '*')).toBe(false);
  });

  it('keeps unsupported check-in and automatic execution separate', () => {
    const doneHub = getSiteAdapterContract('done-hub');
    const codex = getSiteAdapterContract('codex');

    expect(doneHub.checkin).toMatchObject({
      support: 'unsupported',
      allowsAutomaticExecution: false,
    });
    expect(codex.checkin).toMatchObject({
      support: 'unsupported',
      allowsAutomaticExecution: false,
    });
  });

  it('returns a defensive copy for callers that build adapter metadata', () => {
    const first = getSiteAdapterContract('new-api');
    const second = getSiteAdapterContract('new-api');

    expect(first).not.toBe(second);
    first.browser.fields[0]!.name = 'mutated';
    expect(second.browser.fields[0]!.name).toBe('session_cookie');
  });

  it('provides a safe default for an unknown platform', () => {
    const contract = getSiteAdapterContract('custom-fork');

    expect(contract.platformName).toBe('custom-fork');
    expect(contract.browser.supported).toBe(false);
    expect(validateSiteAdapterContract(contract)).toEqual([]);
  });
});
