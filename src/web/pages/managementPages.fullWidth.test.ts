import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pages = [
  'src/web/pages/CredentialVault.tsx',
  'src/web/pages/BrowserRecoveryTasks.tsx',
  'src/web/pages/LocalConnector.tsx',
  'src/web/pages/Settings.tsx',
  'src/web/pages/NotificationSettings.tsx',
];

describe('management page full-width layout', () => {
  it('keeps management and settings page content on the shared full-width stack', () => {
    for (const page of pages) {
      const source = readFileSync(resolve(process.cwd(), page), 'utf8');
      expect(source, page).toContain('className="management-page-stack"');
    }

    const settingsSource = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8');
    const notificationSettingsSource = readFileSync(resolve(process.cwd(), 'src/web/pages/NotificationSettings.tsx'), 'utf8');
    expect(settingsSource).not.toContain('maxWidth: 720');
    expect(notificationSettingsSource).not.toContain('maxWidth: 860');

    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    expect(css).toMatch(/\.management-page-stack\s*{[^}]*display:\s*grid;[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
  });
});
