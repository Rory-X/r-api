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

    expect(route).toContain("from '../../services/credentialLifecycleService.js'");
    expect(route).not.toMatch(/from ['"].*\/db\//);
    expect(route).not.toContain('schema.');
    expect(route).not.toContain('refreshOauthAccessToken');

    expect(service).toContain("from './oauth/service.js'");
    expect(service).toContain("from './sub2apiRefreshSingleflight.js'");
    expect(service).toContain("from './credentialVaultService.js'");
    expect(service).not.toMatch(/from ['"].*\/routes\//);
  });
});
