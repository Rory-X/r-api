import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('password relogin ownership', () => {
  it('keeps login and credential persistence in one shared service', () => {
    for (const file of ['balanceService.ts', 'checkinService.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toContain("from './accountReloginService.js'");
      expect(source).not.toContain('adapter.login(');
      expect(source).not.toContain('decryptAccountPassword');
    }
    const service = readFileSync(new URL('./accountReloginService.ts', import.meta.url), 'utf8');
    expect(service).not.toContain('/routes/');
    expect(service).toContain("from './accountCredentialService.js'");
  });
});
