import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VAULT_FILES = [
  'src/web/pages/CredentialVault.tsx',
  'src/web/pages/credential-management/VaultInventoryPanel.tsx',
];

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
}

describe('credential vault boundaries', () => {
  it('keeps the settings page focused on Vault inventory only', () => {
    const page = source('src/web/pages/CredentialVault.tsx');
    expect(page).toContain('安全凭证库');
    expect(page).toContain('className="management-page-stack"');
    expect(page).toContain("from './credential-management/VaultInventoryPanel.js'");
    expect(page).not.toContain('CredentialInventoryPanel');
    expect(page).not.toContain('CredentialImportPanel');
    expect(page).not.toContain('CredentialImportJobsPanel');
    expect(page).not.toContain('role="tablist"');
  });

  it('uses shared controls and stays independent from Connector surfaces', () => {
    for (const file of VAULT_FILES) {
      const content = source(file);
      expect(content, file).not.toMatch(/<(?:button|input|select|textarea|details|summary)\b/);
      expect(content, file).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/);
      expect(content, file).not.toMatch(/(?:LocalConnector|local-connector|Connector 工作台|本地 Connector)/);
    }
  });

  it('does not import official credential pool or channel orchestration into Vault', () => {
    const page = source('src/web/pages/CredentialVault.tsx');
    expect(page).not.toMatch(/OAuthManagement|official-credentials|ChannelManagement/);
  });
});
