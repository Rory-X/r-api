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
});
