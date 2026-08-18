import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('local connector npm package', () => {
  it('publishes the connector as a standalone minimal package', () => {
    const root = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const connector = JSON.parse(
      readFileSync(resolve('packages/metapi-connector/package.json'), 'utf8'),
    ) as {
      name?: string;
      version?: string;
      bin?: Record<string, string>;
      files?: string[];
      engines?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const identity = readFileSync(resolve('src/server/local-connector/identity.ts'), 'utf8');
    const readme = readFileSync(resolve('packages/metapi-connector/README.md'), 'utf8');
    const sourceVersion = identity.match(/CONNECTOR_VERSION = '([^']+)'/)?.[1];

    expect(connector.name).toBe('metapi-connector');
    expect(root.bin).toBeUndefined();
    expect(connector.version).toBe(sourceVersion);
    expect(connector.bin).toEqual({ 'metapi-connector': 'dist/cli.js' });
    expect(connector.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(connector.engines).toEqual({ node: '>=22.15.0' });
    expect(Object.keys(connector.dependencies || {}).sort()).toEqual(['get-port', 'smol-toml', 'ws']);
    expect(readme).toContain('metapi-connector run --direct');
    expect(readme).toContain('metapi-connector doctor');
    expect(readme).toContain('metapi-connector dashboard --open');
    expect(readme).toContain('metapi-connector install-service');
    expect(readme).toContain('metapi-connector uninstall-service');
    expect(readme).toContain('metapi-connector run --help');
    expect(root.scripts?.['connector:package']).toContain('build-local-connector-package.ts');
    expect(root.scripts?.['connector:publish']).toContain('npm publish ./packages/metapi-connector');
  });
});
