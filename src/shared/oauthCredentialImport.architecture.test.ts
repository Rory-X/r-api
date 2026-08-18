import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('oauth credential import architecture', () => {
  it('keeps format normalization in one shared pure contract', () => {
    const shared = read('src/shared/oauthCredentialImport.js');
    const server = read('src/server/services/oauth/service.ts');
    const web = read('src/web/pages/OAuthManagement.tsx');

    expect(server).toContain("from '../../../shared/oauthCredentialImport.js'");
    expect(web).toContain("from '../../shared/oauthCredentialImport.js'");
    expect(shared).not.toMatch(/from ['"].*server\//);
    expect(shared).not.toMatch(/from ['"].*web\//);
    expect(shared).not.toContain('schema.');
    expect(shared).not.toContain('/api/oauth/import');
  });
});
