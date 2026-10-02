import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('credential lifecycle architecture boundaries', () => {
  it('keeps lifecycle routes thin and delegates workflows to services', () => {
    const route = source('src/server/routes/api/credentialLifecycle.ts');
    const service = source('src/server/services/credentialLifecycleService.ts');
    const refreshService = source('src/server/services/managedCredentialRefreshService.ts');
    const operationsService = source('src/server/services/credentialLifecycleOperationsService.ts');

    expect(route).toContain("from '../../services/credentialLifecycleService.js'");
    expect(route).toContain("from '../../services/credentialLifecycleOperationsService.js'");
    expect(route).not.toMatch(/from ['"].*\/db\//);
    expect(route).not.toContain('schema.');
    expect(route).not.toContain('refreshOauthAccessToken');

    expect(service).toContain("from './managedCredentialRefreshService.js'");
    expect(service).toContain("from './credentialVaultService.js'");
    expect(service).not.toMatch(/from ['"].*\/routes\//);
    expect(refreshService).toContain("from './oauth/service.js'");
    expect(refreshService).toContain("from './sub2apiRefreshSingleflight.js'");
    expect(operationsService).not.toMatch(/from ['"].*\/routes\//);
  });
});
