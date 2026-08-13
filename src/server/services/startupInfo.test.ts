import { describe, expect, it } from 'vitest';
import { buildStartupEndpoints, buildStartupSummaryLines } from './startupInfo.js';

describe('startupInfo', () => {
  it('builds single-port endpoint summary for admin and proxy APIs', () => {
    const endpoints = buildStartupEndpoints({
      port: 4000,
      host: '0.0.0.0',
    });

    expect(endpoints.baseUrl).toBe('http://127.0.0.1:4000');
    expect(endpoints.adminDashboardUrl).toBe('http://127.0.0.1:4000');
    expect(endpoints.adminApiExample).toBe('http://127.0.0.1:4000/api/stats/dashboard');
    expect(endpoints.proxyApiExample).toBe('http://127.0.0.1:4000/v1/chat/completions');
    expect(endpoints.proxyApiCurl).toContain('Authorization: Bearer <PROXY_TOKEN>');
  });

  it('renders copy-ready startup summary lines', () => {
    const lines = buildStartupSummaryLines({
      port: 4000,
      host: '0.0.0.0',
    });

    expect(lines.some((line) => line.includes('r-api running'))).toBe(true);
    expect(lines.some((line) => line.includes('Dashboard: http://127.0.0.1:4000'))).toBe(true);
    expect(lines.some((line) => line.includes('/api/stats/dashboard'))).toBe(true);
    expect(lines.some((line) => line.includes('/v1/chat/completions'))).toBe(true);
    expect(lines.join('\n')).not.toContain('proxy-token');
  });
});
