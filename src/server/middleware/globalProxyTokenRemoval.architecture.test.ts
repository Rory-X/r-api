import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

describe('global proxy credential removal', () => {
  it('keeps external proxy auth managed-key only', () => {
    const configSource = source('src/server/config.ts');
    const downstreamKeySource = source('src/server/services/downstreamApiKeyService.ts');
    const authSource = source('src/server/middleware/auth.ts');

    expect(configSource).not.toContain('PROXY_TOKEN');
    expect(configSource).not.toContain('proxyToken');
    expect(downstreamKeySource).not.toContain("source: 'global'");
    expect(downstreamKeySource).not.toContain('config.proxyToken');
    expect(authSource).toContain("source: 'managed' | 'internal'");
    expect(authSource).toContain('createInternalProxyAuthHandoffHeaders');
  });

  it('keeps deployment templates free of the removed credential', () => {
    for (const path of [
      '.env.example',
      'docker/.env.example',
      'docker/docker-compose.yml',
      'render.yaml',
      'zeabur-template.yaml',
      'deploy/k3s/chart/values.yaml',
      'deploy/k3s/chart/templates/secret.yaml',
    ]) {
      expect(source(path), path).not.toContain('PROXY_TOKEN');
      expect(source(path), path).not.toContain('proxyToken');
    }
    expect(existsSync(resolve(process.cwd(), 'src/web/pages/downstream-keys/GlobalProxyTokenCard.tsx'))).toBe(false);
  });
});
