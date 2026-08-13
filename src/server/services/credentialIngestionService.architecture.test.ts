import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('credential ingestion architecture boundaries', () => {
  it('keeps source detection and normalization pure', () => {
    const ingestion = source('src/server/services/credentialIngestionService.ts');

    expect(ingestion).not.toMatch(/from ['"].*\/db\//);
    expect(ingestion).not.toMatch(/from ['"].*\/routes\//);
    expect(ingestion).not.toContain('schema.');
    expect(ingestion).not.toContain('insertAndGetById');
    expect(ingestion).not.toContain('storeCredentialVaultItem');
    expect(ingestion).not.toContain('createManualAccount');
  });
});
