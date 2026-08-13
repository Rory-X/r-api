import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html', '.json', '.md', '.yaml', '.yml']);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', '.vitepress']);

const legacyBrandAllowlist: Record<string, RegExp[]> = {
  'src/desktop/main.ts': [
    /LEGACY_USER_DATA_DIR_NAME = 'Metapi'/,
  ],
  'src/server/local-connector/config.ts': [
    /'Metapi', 'Connector'/,
  ],
  'src/server/services/feishuInteractionAdapterService.ts': [
    /\(\?:Metapi\|r-api\)/,
  ],
  'src/web/api.ts': [
    /X-Metapi-CSRF/,
  ],
};

function walk(currentDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(currentDir).sort()) {
    if (ignoredDirectories.has(entry)) continue;
    const fullPath = resolve(currentDir, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (sourceExtensions.has(extname(entry))) files.push(fullPath);
  }
  return files;
}

function isPublishedSurface(file: string): boolean {
  if (file.startsWith('docs/plans/')) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(file)) return false;
  return file.startsWith('src/')
    || file.startsWith('docs/')
    || file.startsWith('packages/')
    || file.startsWith('scripts/')
    || [
      'AGENTS.md',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'README.md',
      'README_EN.md',
      'SECURITY.md',
      'TEST_ENVIRONMENT_SETUP.md',
      'electron-builder.yml',
      'package.json',
      'render.yaml',
      'zeabur-template.yaml',
    ].includes(file);
}

describe('r-api brand boundary', () => {
  it('keeps every published product surface on the r-api display brand', () => {
    const violations: string[] = [];
    for (const fullPath of walk(root)) {
      const file = relative(root, fullPath).replaceAll('\\', '/');
      if (!isPublishedSurface(file)) continue;
      const allowlist = legacyBrandAllowlist[file] || [];
      for (const [index, line] of readFileSync(fullPath, 'utf8').split(/\r?\n/).entries()) {
        if (!/\bMetapi\b/.test(line)) continue;
        if (allowlist.some((pattern) => pattern.test(line))) continue;
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps published compatibility identifiers stable', () => {
    const packageJson = readFileSync('package.json', 'utf8');
    const connectorPackage = readFileSync('packages/metapi-connector/package.json', 'utf8');
    const authService = readFileSync('src/server/services/adminAuthService.ts', 'utf8');
    const connectorProtocol = readFileSync('src/server/local-connector/protocol.ts', 'utf8');
    const dockerImageConfig = readFileSync('src/server/services/updateCenterConfigService.ts', 'utf8');

    expect(packageJson).toContain('packages/metapi-connector');
    expect(connectorPackage).toContain('"name": "metapi-connector"');
    expect(authService).toContain("'x-metapi-csrf'");
    expect(connectorProtocol).toContain("'metapi.local-connector.action.v1'");
    expect(dockerImageConfig).toContain("'1467078763/metapi'");
  });
});
