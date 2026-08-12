import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TokenRouter connection boundary', () => {
  it('selects prepared route channels without owning credential acquisition workflows', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/server/services/tokenRouter.ts'),
      'utf8',
    );

    expect(source).not.toContain("from './credentialVaultService.js'");
    expect(source).not.toContain("from './browserCredentialRecoveryService.js'");
    expect(source).not.toContain("from './oauth/service.js'");
    expect(source).not.toContain("from './oauth/oauthRefreshScheduler.js'");
    expect(source).not.toContain("from './sub2apiRefreshScheduler.js'");
    expect(source).not.toContain("from '../routes/");
  });
});
