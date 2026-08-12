import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const publicSurfaceFiles = [
  'src/web/i18n.tsx',
  'src/web/pages/ChannelManagement.tsx',
  'src/web/pages/CredentialVault.tsx',
  'src/web/pages/LocalConnector.tsx',
  'src/web/pages/BrowserRecoveryTasks.tsx',
  'src/web/pages/BrowserCredentialRecovery.tsx',
  'src/browser-extension/manifest.json',
  'src/browser-extension/popup.html',
  'src/browser-extension/popup.tsx',
  'src/browser-extension/protocol.ts',
  'src/browser-extension/background.ts',
];

describe('browser credential terminology', () => {
  it('uses 浏览器凭证 as the single public feature name', () => {
    for (const file of publicSurfaceFiles) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, file).not.toContain('浏览器恢复');
      expect(source, file).not.toContain('浏览器凭证恢复');
      expect(source, file).not.toContain('Browser Recovery');
    }

    const channelManagement = readFileSync(
      resolve(process.cwd(), 'src/web/pages/ChannelManagement.tsx'),
      'utf8',
    );
    expect(channelManagement).toContain("label: '浏览器凭证'");
  });
});
