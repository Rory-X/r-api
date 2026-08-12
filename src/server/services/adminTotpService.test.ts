import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type ServiceModule = typeof import('./adminTotpService.js');

describe('adminTotpService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let service: ServiceModule;
  let originalDataDir: string | undefined;
  let originalCredentialSecret = '';

  const client = {
    clientIp: '203.0.113.40',
    userAgent: 'metapi-totp-test',
  };

  beforeAll(async () => {
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-admin-totp-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    service = await import('./adminTotpService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    originalCredentialSecret = config.accountCredentialSecret;
  });

  beforeEach(async () => {
    config.accountCredentialSecret = 'totp-test-root-secret-0123456789abcdef';
    await db.delete(schema.adminAuthChallenges).run();
    await db.delete(schema.adminTotpConfigs).run();
  });

  afterAll(() => {
    config.accountCredentialSecret = originalCredentialSecret;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function enableTotp(now: Date) {
    const setup = await service.beginAdminTotpSetup({
      sessionId: 'session-1',
      ...client,
      now,
    });
    const code = service.__adminTotpTestUtils.buildTotp(setup.secret)
      .generate({ timestamp: now.getTime() });
    const confirmed = await service.confirmAdminTotpSetup(setup.setupToken, code, {
      sessionId: 'session-1',
      ...client,
      now,
    });
    return { setup, code, confirmed };
  }

  it('stores only an encrypted secret and hashed recovery codes', async () => {
    const now = new Date('2026-08-04T08:00:00.000Z');
    const enabled = await enableTotp(now);
    const row = await db.select().from(schema.adminTotpConfigs).get();

    expect(row?.encryptedSecret).toMatch(/^v1\./);
    expect(row?.encryptedSecret).not.toContain(enabled.setup.secret);
    expect(row?.recoveryCodeHashes).not.toContain(enabled.confirmed.recoveryCodes[0]);
    expect(service.__adminTotpTestUtils.parseRecoveryCodeHashes(row?.recoveryCodeHashes || '[]'))
      .toHaveLength(10);
    expect(await service.getAdminTotpStatus()).toMatchObject({
      enabled: true,
      recoveryCodesRemaining: 10,
    });
  });

  it('accepts a new TOTP counter once and rejects replay across challenges', async () => {
    const setupAt = new Date('2026-08-04T08:00:00.000Z');
    const enabled = await enableTotp(setupAt);

    const replayChallenge = await service.createAdminLoginTotpChallenge({ ...client, now: setupAt });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: replayChallenge.challengeToken,
      code: enabled.code,
      ...client,
      now: setupAt,
    })).rejects.toMatchObject({ code: 'totp_code_invalid' });

    const nextAt = new Date(setupAt.getTime() + 30_000);
    const nextCode = service.__adminTotpTestUtils.buildTotp(enabled.setup.secret)
      .generate({ timestamp: nextAt.getTime() });
    const nextChallenge = await service.createAdminLoginTotpChallenge({ ...client, now: nextAt });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: nextChallenge.challengeToken,
      code: nextCode,
      ...client,
      now: nextAt,
    })).resolves.toMatchObject({ type: 'totp', recoveryCodesRemaining: 10 });

    const duplicateChallenge = await service.createAdminLoginTotpChallenge({ ...client, now: nextAt });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: duplicateChallenge.challengeToken,
      code: nextCode,
      ...client,
      now: nextAt,
    })).rejects.toMatchObject({ code: 'totp_code_invalid' });
  });

  it('accepts one adjacent clock window but rejects codes outside the skew allowance', async () => {
    const setupAt = new Date('2026-08-04T08:30:00.000Z');
    const enabled = await enableTotp(setupAt);
    const totp = service.__adminTotpTestUtils.buildTotp(enabled.setup.secret);

    const adjacentCodeAt = new Date(setupAt.getTime() + 30_000);
    const verifyAdjacentAt = new Date(setupAt.getTime() + 60_000);
    const adjacentCode = totp.generate({ timestamp: adjacentCodeAt.getTime() });
    const adjacentChallenge = await service.createAdminLoginTotpChallenge({
      ...client,
      now: verifyAdjacentAt,
    });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: adjacentChallenge.challengeToken,
      code: adjacentCode,
      ...client,
      now: verifyAdjacentAt,
    })).resolves.toMatchObject({ type: 'totp' });

    const staleCodeAt = new Date(setupAt.getTime() + 90_000);
    const verifyStaleAt = new Date(setupAt.getTime() + 150_000);
    const staleCode = totp.generate({ timestamp: staleCodeAt.getTime() });
    const staleChallenge = await service.createAdminLoginTotpChallenge({
      ...client,
      now: verifyStaleAt,
    });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: staleChallenge.challengeToken,
      code: staleCode,
      ...client,
      now: verifyStaleAt,
    })).rejects.toMatchObject({ code: 'totp_code_invalid' });
  });

  it('consumes each recovery code once', async () => {
    const now = new Date('2026-08-04T09:00:00.000Z');
    const enabled = await enableTotp(now);
    const recoveryCode = enabled.confirmed.recoveryCodes[0];

    const first = await service.createAdminLoginTotpChallenge({ ...client, now });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: first.challengeToken,
      code: recoveryCode,
      ...client,
      now,
    })).resolves.toMatchObject({ type: 'recovery_code', recoveryCodesRemaining: 9 });

    const second = await service.createAdminLoginTotpChallenge({ ...client, now });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: second.challengeToken,
      code: recoveryCode,
      ...client,
      now,
    })).rejects.toMatchObject({ code: 'totp_code_invalid' });
  });

  it('binds setup and login challenges to the originating session/client', async () => {
    const now = new Date('2026-08-04T10:00:00.000Z');
    const setup = await service.beginAdminTotpSetup({
      sessionId: 'session-1',
      ...client,
      now,
    });
    const code = service.__adminTotpTestUtils.buildTotp(setup.secret)
      .generate({ timestamp: now.getTime() });

    await expect(service.confirmAdminTotpSetup(setup.setupToken, code, {
      sessionId: 'session-2',
      ...client,
      now,
    })).rejects.toMatchObject({ code: 'totp_setup_session_mismatch' });

    await service.confirmAdminTotpSetup(setup.setupToken, code, {
      sessionId: 'session-1',
      ...client,
      now,
    });
    const nextAt = new Date(now.getTime() + 30_000);
    const nextCode = service.__adminTotpTestUtils.buildTotp(setup.secret)
      .generate({ timestamp: nextAt.getTime() });
    const challenge = await service.createAdminLoginTotpChallenge({ ...client, now: nextAt });
    await expect(service.verifyAdminLoginTotpChallenge({
      challengeToken: challenge.challengeToken,
      code: nextCode,
      clientIp: '203.0.113.41',
      userAgent: client.userAgent,
      now: nextAt,
    })).rejects.toMatchObject({ code: 'totp_challenge_binding_mismatch' });
  });
});
