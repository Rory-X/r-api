import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('operational failure classification architecture', () => {
  it('keeps the canonical vocabulary neutral and shared by operational surfaces', () => {
    const contract = source('src/server/services/operationalFailureContract.ts');
    expect(contract).not.toMatch(/from ['"].*\/(?:db|routes)\//);

    for (const path of [
      'src/server/services/proxyRetryContract.ts',
      'src/server/services/proxyHealthDomain.ts',
      'src/server/services/proxyRoutingExplanation.ts',
      'src/server/services/alertRules.ts',
      'src/server/services/credentialLifecycleOperationsService.ts',
    ]) {
      expect(source(path)).toContain('operationalFailureContract');
    }
  });
});
