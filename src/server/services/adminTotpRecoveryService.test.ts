import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';

describe('adminTotpRecoveryService', () => {
  const originalEnv = { ...process.env };
  let dataDir = '';
  let dbModule: typeof import('../db/index.js');
  let service: typeof import('./adminTotpRecoveryService.js');

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-admin-totp-recovery-'));
    process.env.DATA_DIR = dataDir;
    process.env.DB_TYPE = 'sqlite';
    process.env.DB_URL = join(dataDir, 'hub.db');
    process.env.AUTH_TOKEN = 'administrator-secret';
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'account-credential-secret-for-tests';
    await import('../db/migrate.js');
    dbModule = await import('../db/index.js');
    const { hashAdminCredential } = await import('./adminAuthService.js');
    service = await import('./adminTotpRecoveryService.js');

    await dbModule.db.insert(dbModule.schema.settings).values({
      key: 'admin_password_hash',
      value: await hashAdminCredential('administrator-secret'),
    }).run();
    await dbModule.db.insert(dbModule.schema.adminTotpConfigs).values({
      id: 'primary',
      encryptedSecret: 'encrypted-secret',
      recoveryCodeHashes: JSON.stringify(['a'.repeat(64)]),
      enabledAt: '2026-08-04 00:00:00',
      createdAt: '2026-08-04 00:00:00',
      updatedAt: '2026-08-04 00:00:00',
    }).run();
    await dbModule.db.insert(dbModule.schema.adminSessions).values({
      id: 'session-before-recovery',
      tokenHash: 'b'.repeat(64),
      csrfToken: 'csrf-before-recovery',
      secondFactorVerifiedAt: '2026-08-04 00:00:00',
      expiresAt: '2026-08-05 00:00:00',
      lastSeenAt: '2026-08-04 00:00:00',
      createdAt: '2026-08-04 00:00:00',
      updatedAt: '2026-08-04 00:00:00',
    }).run();
  });

  afterAll(async () => {
    await dbModule?.closeDbConnections();
    process.env = originalEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires explicit confirmation and the current credential before disabling TOTP', async () => {
    await expect(service.recoverAdminTotpAccess({
      administratorCredential: 'administrator-secret',
      confirmation: 'wrong',
    })).rejects.toMatchObject({ code: 'confirmation_required' });
    await expect(service.recoverAdminTotpAccess({
      administratorCredential: 'wrong-secret',
      confirmation: service.ADMIN_TOTP_RECOVERY_CONFIRMATION,
    })).rejects.toMatchObject({ code: 'credential_invalid' });

    const result = await service.recoverAdminTotpAccess({
      administratorCredential: 'administrator-secret',
      confirmation: service.ADMIN_TOTP_RECOVERY_CONFIRMATION,
      now: new Date('2026-08-04T01:00:00.000Z'),
    });

    expect(result).toEqual({ disabled: true, sessionsRevoked: true });
    expect(await dbModule.db.select().from(dbModule.schema.adminTotpConfigs).all()).toEqual([]);
    const session = await dbModule.db.select().from(dbModule.schema.adminSessions).get();
    expect(session?.revokedAt).toBe('2026-08-04 01:00:00');
    const passwordHash = String((await dbModule.db.select().from(dbModule.schema.settings).get())?.value || '');
    expect(await argon2.verify(passwordHash, 'administrator-secret')).toBe(true);
  });
});
