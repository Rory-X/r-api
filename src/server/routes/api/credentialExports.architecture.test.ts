import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('credential export architecture boundaries', () => {
  it('keeps the route thin and export orchestration in the service layer', () => {
    const route = source('src/server/routes/api/credentialExports.ts');
    const service = source('src/server/services/credentialExportService.ts');

    expect(route).toContain("from '../../services/credentialExportService.js'");
    expect(route).not.toMatch(/from ['"].*\/db\//);
    expect(route).not.toContain('schema.');
    expect(route).not.toContain('createCipheriv');
    expect(route).not.toContain('credentialVaultInternals');

    expect(service).toContain("from '../db/index.js'");
    expect(service).toContain("from './credentialVaultService.js'");
    expect(service).not.toMatch(/from ['"].*\/routes\//);
  });
});
