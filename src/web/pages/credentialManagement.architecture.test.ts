import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKBENCH_FILES = [
  'src/web/pages/CredentialVault.tsx',
  'src/web/pages/credential-management/CredentialInventoryPanel.tsx',
  'src/web/pages/credential-management/CredentialImportPanel.tsx',
  'src/web/pages/credential-management/CredentialImportJobsPanel.tsx',
  'src/web/pages/credential-management/VaultInventoryPanel.tsx',
];

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
}

describe('credential management workbench boundaries', () => {
  it('keeps the top-level page as a four-view orchestration surface', () => {
    const page = source('src/web/pages/CredentialVault.tsx');
    expect(page).toContain("type WorkspaceView = 'inventory' | 'import' | 'jobs' | 'vault'");
    expect(page).toContain('className="management-page-stack"');
    expect(page).toContain('role="tablist"');
    expect(page).toContain("from './credential-management/CredentialInventoryPanel.js'");
    expect(page).toContain("from './credential-management/CredentialImportPanel.js'");
    expect(page).toContain("from './credential-management/CredentialImportJobsPanel.js'");
    expect(page).toContain("from './credential-management/VaultInventoryPanel.js'");
  });

  it('uses shared controls and stays independent from Connector surfaces', () => {
    for (const file of WORKBENCH_FILES) {
      const content = source(file);
      expect(content, file).not.toMatch(/<(?:button|input|select|textarea|details|summary)\b/);
      expect(content, file).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/);
      expect(content, file).not.toMatch(/(?:LocalConnector|local-connector|Connector 工作台|本地 Connector)/);
    }
  });

  it('keeps list-heavy views on shared mobile primitives', () => {
    const inventory = source('src/web/pages/credential-management/CredentialInventoryPanel.tsx');
    expect(inventory).toContain("from '../../components/MobileCard.js'");
    expect(inventory).toContain("from '../../components/ResponsiveBatchActionBar.js'");
    expect(inventory).toContain("from '../../components/ResponsiveFilterPanel.js'");
    expect(inventory).toContain("from '../../components/useIsMobile.js'");

    const jobs = source('src/web/pages/credential-management/CredentialImportJobsPanel.tsx');
    expect(jobs).toContain("from '../../components/MobileCard.js'");
    expect(jobs).toContain("from '../../components/useIsMobile.js'");
  });
});
