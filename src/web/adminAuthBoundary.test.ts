import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('administrator browser auth boundary', () => {
  it('keeps administrator secrets out of WebUI API requests', () => {
    const apiSource = readSource('src/web/api.ts');
    const appSource = readSource('src/web/App.tsx');

    expect(apiSource).not.toMatch(/Authorization["'`]?,\s*`Bearer/);
    expect(apiSource).not.toMatch(/headers\.set\(["']Authorization["']/);
    expect(appSource).not.toContain('Authorization: `Bearer');
    expect(apiSource).toContain('credentials: "same-origin"');
    expect(apiSource).toContain('X-Metapi-CSRF');
  });

  it('uses localStorage auth keys only for one-way legacy cleanup', () => {
    const sessionSource = readSource('src/web/authSession.ts');

    expect(sessionSource).toContain("const LEGACY_AUTH_TOKEN_STORAGE_KEY = 'auth_token'");
    expect(sessionSource).not.toMatch(/setItem\(LEGACY_AUTH_TOKEN_STORAGE_KEY/);
    expect(sessionSource).toContain('removeItem(LEGACY_AUTH_TOKEN_STORAGE_KEY)');
  });
});
