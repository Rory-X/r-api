import { describe, expect, it } from 'vitest';
import { Headers } from 'undici';
import { mergeHeadersWithSiteCustomHeaders } from './siteCustomHeaders.js';

describe('mergeHeadersWithSiteCustomHeaders', () => {
  it.each(['request', 'site'] as const)('applies %s priority consistently to credential and content headers', (priority) => {
    const site = { Authorization: 'Bearer site', Cookie: 'session=site', 'Content-Type': 'application/site', Version: 'site-version' };
    const request = { authorization: 'Bearer request', cookie: 'session=request', 'content-type': 'application/request', version: 'request-version' };
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(site, request, { priority }));
    for (const [key, value] of Object.entries(priority === 'site' ? site : request)) {
      expect(merged.get(key)).toBe(value);
    }
    expect(Array.from(merged.keys())).toHaveLength(4);
    expect(request.authorization).toBe('Bearer request');
  });

  it('keeps explicit request headers authoritative by default', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'User-Agent': 'site-agent', 'X-Site-Scope': 'internal' }),
      { 'user-agent': 'request-agent' },
    ));

    expect(merged.get('user-agent')).toBe('request-agent');
    expect(merged.get('x-site-scope')).toBe('internal');
  });

  it('lets site custom headers override request headers when site priority is enabled', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'User-Agent': 'site-agent', 'X-Site-Scope': 'internal' }),
      { 'user-agent': 'request-agent', 'X-Trace-Id': 'trace-1' },
      { priority: 'site' },
    ));

    expect(merged.get('user-agent')).toBe('site-agent');
    expect(merged.get('x-site-scope')).toBe('internal');
    expect(merged.get('x-trace-id')).toBe('trace-1');
  });

  it('returns the original request headers when no site custom headers are configured', () => {
    const requestHeaders = { 'X-Trace-Id': 'trace-1' };

    expect(mergeHeadersWithSiteCustomHeaders(null, requestHeaders)).toBe(requestHeaders);
  });
});
