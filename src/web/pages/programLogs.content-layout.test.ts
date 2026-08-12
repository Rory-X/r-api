import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ProgramLogs content presentation', () => {
  it('clamps list summaries and keeps full content in a scrollable detail modal', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProgramLogs.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');

    expect(source).toContain('summarizeEventMessage(row.message)');
    expect(source).toContain('program-log-summary-button');
    expect(source).toContain('title="程序日志详情"');
    expect(source).toContain('maxWidth={880}');
    expect(source).toContain("maxHeight: 'calc(100dvh - 190px)', overflowY: 'auto'");
    expect(css).toMatch(/\.modal-content\s*{[^}]*width:\s*calc\(100vw - 32px\);/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.modal-backdrop:not\(\.oauth-drawer-backdrop\)\s*{[^}]*padding:\s*12px;[\s\S]*?\.modal-content\s*{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/s);
    expect(css).toMatch(/\.modal-content\.oauth-drawer-content\s*{[^}]*width:\s*min\(92vw, 560px\);[^}]*margin:\s*0;/s);
    expect(css).toMatch(/\.program-log-summary-text\s*{[^}]*overflow:\s*hidden;[^}]*-webkit-line-clamp:\s*3;/s);
    expect(css).toMatch(/\.program-log-detail-message\s*{[^}]*white-space:\s*pre-wrap;/s);
  });
});
