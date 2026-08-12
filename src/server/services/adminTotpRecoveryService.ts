import { eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { verifyAdminCredential } from './adminAuthService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

export const ADMIN_TOTP_RECOVERY_CONFIRMATION = 'disable-totp';

export class AdminTotpRecoveryError extends Error {
  constructor(
    public readonly code: 'confirmation_required' | 'credential_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AdminTotpRecoveryError';
  }
}

export async function recoverAdminTotpAccess(input: {
  administratorCredential: string;
  confirmation: string;
  now?: Date;
}): Promise<{ disabled: boolean; sessionsRevoked: boolean }> {
  if (input.confirmation.trim() !== ADMIN_TOTP_RECOVERY_CONFIRMATION) {
    throw new AdminTotpRecoveryError(
      'confirmation_required',
      `Set the confirmation value to ${ADMIN_TOTP_RECOVERY_CONFIRMATION}`,
    );
  }
  if (!await verifyAdminCredential(input.administratorCredential)) {
    throw new AdminTotpRecoveryError('credential_invalid', 'Administrator credential is invalid');
  }

  const existing = await db.select({ id: schema.adminTotpConfigs.id })
    .from(schema.adminTotpConfigs)
    .where(eq(schema.adminTotpConfigs.id, 'primary'))
    .get();
  const nowText = formatUtcSqlDateTime(input.now ?? new Date());

  await db.transaction(async (tx) => {
    await tx.delete(schema.adminAuthChallenges).run();
    await tx.delete(schema.adminTotpConfigs)
      .where(eq(schema.adminTotpConfigs.id, 'primary'))
      .run();
    await tx.update(schema.adminSessions)
      .set({ revokedAt: nowText, updatedAt: nowText })
      .where(isNull(schema.adminSessions.revokedAt))
      .run();
  });

  return {
    disabled: !!existing,
    sessionsRevoked: true,
  };
}
