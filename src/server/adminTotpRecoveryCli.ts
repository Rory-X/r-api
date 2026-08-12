import { closeDbConnections } from './db/index.js';
import {
  ADMIN_TOTP_RECOVERY_CONFIRMATION,
  recoverAdminTotpAccess,
} from './services/adminTotpRecoveryService.js';

async function main() {
  const administratorCredential = (process.env.METAPI_ADMIN_RECOVERY_CREDENTIAL || '').trim();
  const confirmation = (process.env.METAPI_ADMIN_TOTP_RESET_CONFIRM || '').trim();
  delete process.env.METAPI_ADMIN_RECOVERY_CREDENTIAL;

  if (!administratorCredential) {
    throw new Error('METAPI_ADMIN_RECOVERY_CREDENTIAL is required');
  }
  if (confirmation !== ADMIN_TOTP_RECOVERY_CONFIRMATION) {
    throw new Error(
      `METAPI_ADMIN_TOTP_RESET_CONFIRM must equal ${ADMIN_TOTP_RECOVERY_CONFIRMATION}`,
    );
  }

  const result = await recoverAdminTotpAccess({
    administratorCredential,
    confirmation,
  });
  console.log(result.disabled
    ? 'Administrator TOTP disabled. All administrator sessions were revoked.'
    : 'Administrator TOTP was already disabled. All administrator sessions were revoked.');
}

main()
  .catch((error) => {
    console.error(`Administrator TOTP recovery failed: ${(error as Error)?.message || 'unknown error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbConnections();
  });
