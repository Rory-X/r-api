import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('notification panel row layout', () => {
  it('keeps long notification text from stretching a row', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/web/components/NotificationPanel.tsx'),
      'utf8',
    );
    const css = readFileSync(
      resolve(process.cwd(), 'src/web/index.css'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(source).toContain('className="notification-event-title"');
    expect(source).toContain('className="notification-event-message"');
    expect(css).toMatch(/\.notification-event-item\s*{[^}]*max-height:\s*94px;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.notification-event-title\s*{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.notification-event-message\s*{[^}]*overflow:\s*hidden;[^}]*-webkit-line-clamp:\s*2;/s);
  });

  it('keeps the mobile popover inside the viewport and above the quick navigation', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/web/components/NotificationPanel.tsx'),
      'utf8',
    );
    const css = readFileSync(
      resolve(process.cwd(), 'src/web/index.css'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(source).toContain("import { createPortal } from 'react-dom';");
    expect(source).toContain("import { useIsMobile } from './useIsMobile.js';");
    expect(source).toContain('user-dropdown notification-popover');
    expect(source).toContain('className="notification-popover-list"');
    expect(source).toContain('className="notification-popover-close"');
    expect(source).toContain('createPortal(panel, document.body)');
    expect(css).toMatch(/\.notification-popover\s*{[^}]*width:\s*min\(360px, calc\(100vw - 24px\)\);[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/@media \(max-width:\s*768px\)[\s\S]*?\.notification-popover\s*{[^}]*position:\s*fixed;[^}]*inset:\s*calc\(var\(--topbar-height\) \+ 6px\)\s+8px\s+calc\(72px \+ env\(safe-area-inset-bottom\)\);/s);
    expect(css).toMatch(/\.notification-popover-list\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
  });
});
