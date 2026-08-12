import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORKED_BUSINESS_SURFACES = [
  'src/web/pages/BridgeContinuations.tsx',
  'src/web/pages/BrowserCredentialRecovery.tsx',
  'src/web/pages/BrowserRecoveryTasks.tsx',
  'src/web/pages/CredentialVault.tsx',
  'src/web/pages/InteractionRequests.tsx',
  'src/web/pages/LocalConnector.tsx',
  'src/web/pages/NotificationSettings.tsx',
  'src/web/pages/downstream-keys/DownstreamKeyEditorModal.tsx',
  'src/web/pages/interactions/FeishuInteractionAdaptersPanel.tsx',
  'src/web/pages/interactions/FeishuPromptCardsPanel.tsx',
  'src/web/pages/proxy-logs/ProxyRequestLedgerPanel.tsx',
  'src/web/components/ChangeKeyModal.tsx',
  'src/web/components/AdminTotpModal.tsx',
  'src/browser-extension/popup.tsx',
];

describe('forked business UI component boundary', () => {
  it.each(FORKED_BUSINESS_SURFACES)('%s uses shared controls instead of browser-native controls', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

    expect(source).not.toMatch(/<(?:button|input|select|textarea|details|summary)\b/);
    expect(source).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/);
    expect(source).not.toContain('modal-backdrop');
  });

  it('keeps forked Settings sections on shared controls', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const sections = [
      source.slice(source.indexOf('管理员安全'), source.indexOf('定时任务')),
      source.slice(source.indexOf('签到执行窗口'), source.indexOf('自动清理日志')),
      source.slice(source.indexOf('余额路由策略'), source.indexOf('保存路由策略')),
    ];

    for (const section of sections) {
      expect(section).not.toMatch(/<(?:button|input|select|textarea|details|summary)\b/);
      expect(section).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/);
    }
  });
});
