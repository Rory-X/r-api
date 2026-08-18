import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProxyLogs mobile layout', () => {
  it('renders compact mobile summary cards for proxy logs', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProxyLogs.tsx'), 'utf8');
    expect(source).toContain('MobileCard');
    expect(source).toContain(
      'import ResponsiveFilterPanel from "../components/ResponsiveFilterPanel.js";',
    );
    expect(source).toContain('<ResponsiveFilterPanel');
    expect(source).toContain('compact');
    expect(source).toContain('mobile-summary-grid');
    expect(source).toContain("subtitle={formatDateTimeLocal(log.createdAt)}");
    expect(source).toContain('proxy-log-mobile-detail-section');
    expect(source).toContain('label="总 Tokens"');
    expect(source).toContain('label="下游请求路径"');
    expect(source).toContain('label="上游请求路径"');
  });
});
