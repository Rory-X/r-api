import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('credential import architecture boundaries', () => {
  it('keeps routes as adapters and promotion in the service layer', () => {
    const route = source('src/server/routes/api/credentialImports.ts');
    const promotion = source('src/server/services/credentialPromotionService.ts');

    expect(route).toContain("from '../../services/credentialIngestionService.js'");
    expect(route).toContain("from '../../services/credentialPromotionService.js'");
    expect(route).toContain("from '../../services/credentialImportJobService.js'");
    expect(route).not.toMatch(/from ['"].*\/db\//);
    expect(route).not.toContain('schema.');
    expect(route).not.toContain('createManualAccount');
    expect(route).not.toContain('storeCredentialVaultItem');

    expect(promotion).toContain("from './manualAccountCreationService.js'");
    expect(promotion).toContain("from './accountLoginService.js'");
    expect(promotion).toContain("from './accountSessionRebindService.js'");
    expect(promotion).toContain("from './oauth/service.js'");
    expect(promotion).toContain("from './credentialVaultService.js'");
    expect(promotion).not.toMatch(/from ['"].*\/routes\//);

    const jobs = source('src/server/services/credentialImportJobService.ts');
    expect(jobs).toContain("from '../db/index.js'");
    expect(jobs).toContain("from './credentialIngestionService.js'");
    expect(jobs).toContain("from './credentialPromotionService.js'");
    expect(jobs).not.toMatch(/from ['"].*\/routes\//);
  });
});
