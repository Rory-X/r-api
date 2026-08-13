import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';

export const AUTHENTICATED_MONITOR_SITES = {
  'ldoh-105117': {
    baseUrl: 'https://ldoh.105117.xyz',
    proxyPrefix: '/monitor-proxy/ldoh',
    cookieSettingKey: 'monitor_ldoh_cookie',
  },
  'aihub-top': {
    baseUrl: 'https://aihub.top',
    proxyPrefix: '/monitor-proxy/aihub',
    cookieSettingKey: 'monitor_aihub_cookie',
  },
} as const;

export type AuthenticatedMonitorSiteId = keyof typeof AUTHENTICATED_MONITOR_SITES;

export type MonitorSiteCookieState = {
  configured: boolean;
  masked: string;
};

export type MonitorProxyRequest = {
  requestUrl: string;
  wildcardPath?: string;
  query?: Record<string, unknown>;
  method: string;
  headers: {
    accept?: string;
    acceptLanguage?: string;
    userAgent?: string;
    contentType?: string;
    referer?: string;
  };
  body?: unknown;
};

export type MonitorProxyResponse = {
  status: number;
  contentType: string;
  cacheControl: string | null;
  location: string | null;
  body: string | Buffer;
};

export class MissingMonitorCookieError extends Error {
  constructor(siteId: AuthenticatedMonitorSiteId) {
    super(`${siteId} cookie not configured`);
    this.name = 'MissingMonitorCookieError';
  }
}

async function getSettingString(key: string): Promise<string> {
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (!row?.value) return '';
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

export function maskMonitorCookie(cookieText: string): string {
  const value = cookieText.trim();
  if (!value) return '';
  const index = value.indexOf('=');
  const raw = index >= 0 ? value.slice(index + 1) : value;
  if (raw.length <= 10) return `${raw.slice(0, 2)}****`;
  return `${raw.slice(0, 6)}****${raw.slice(-4)}`;
}

export function normalizeLinuxDoSessionCookie(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const pair = trimmed
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('ld_auth_session='));
  return pair || `ld_auth_session=${trimmed}`;
}

export async function getMonitorSiteCookieState(
  siteId: AuthenticatedMonitorSiteId,
): Promise<MonitorSiteCookieState> {
  const config = AUTHENTICATED_MONITOR_SITES[siteId];
  const cookie = await getSettingString(config.cookieSettingKey);
  return {
    configured: Boolean(cookie),
    masked: cookie ? maskMonitorCookie(cookie) : '',
  };
}

export async function getMonitorCookieConfig(): Promise<{
  ldohCookieConfigured: boolean;
  ldohCookieMasked: string;
  aihubCookieConfigured: boolean;
  aihubCookieMasked: string;
}> {
  const [ldoh, aihub] = await Promise.all([
    getMonitorSiteCookieState('ldoh-105117'),
    getMonitorSiteCookieState('aihub-top'),
  ]);
  return {
    ldohCookieConfigured: ldoh.configured,
    ldohCookieMasked: ldoh.masked,
    aihubCookieConfigured: aihub.configured,
    aihubCookieMasked: aihub.masked,
  };
}

export async function saveMonitorSiteCookie(
  siteId: AuthenticatedMonitorSiteId,
  raw: string | null | undefined,
): Promise<MonitorSiteCookieState> {
  const config = AUTHENTICATED_MONITOR_SITES[siteId];
  const input = String(raw || '').trim();
  if (!input) {
    await upsertSetting(config.cookieSettingKey, '');
    return { configured: false, masked: '' };
  }

  const normalized = normalizeLinuxDoSessionCookie(input);
  if (!normalized.startsWith('ld_auth_session=') || normalized.length < 24) {
    throw new Error('Cookie 格式无效，请填写 ld_auth_session 或其值');
  }
  await upsertSetting(config.cookieSettingKey, normalized);
  return { configured: true, masked: maskMonitorCookie(normalized) };
}

export function resolveMonitorProxyPath(
  siteId: AuthenticatedMonitorSiteId,
  requestUrl: string,
  wildcard = '',
): string {
  const prefix = AUTHENTICATED_MONITOR_SITES[siteId].proxyPrefix;
  const cleanPath = String(requestUrl || '').split('?')[0] || '';
  if (cleanPath === prefix || cleanPath === `${prefix}/`) return '';
  if (cleanPath.startsWith(`${prefix}/`)) return cleanPath.slice(prefix.length + 1);
  return wildcard;
}

export function rewriteMonitorProxyText(siteId: AuthenticatedMonitorSiteId, text: string): string {
  const config = AUTHENTICATED_MONITOR_SITES[siteId];
  const escapedBaseUrl = config.baseUrl.replaceAll('/', '\\/');
  const escapedPrefix = config.proxyPrefix.replaceAll('/', '\\/');
  return text
    .replaceAll(`${config.baseUrl}/`, `${config.proxyPrefix}/`)
    .replaceAll(`${escapedBaseUrl}\\/`, `${escapedPrefix}\\/`)
    .replaceAll('src="/', `src="${config.proxyPrefix}/`)
    .replaceAll("src='/", `src='${config.proxyPrefix}/`)
    .replaceAll('href="/', `href="${config.proxyPrefix}/`)
    .replaceAll("href='/", `href='${config.proxyPrefix}/`)
    .replaceAll('action="/', `action="${config.proxyPrefix}/`)
    .replaceAll("action='/", `action='${config.proxyPrefix}/`)
    .replaceAll('"\\/api/', `"${escapedPrefix}\\/api/`)
    .replaceAll("'/api/", `'${config.proxyPrefix}/api/`)
    .replaceAll('"/api/', `"${config.proxyPrefix}/api/`);
}

export function rewriteMonitorLocation(
  siteId: AuthenticatedMonitorSiteId,
  location: string | null,
): string | null {
  if (!location) return null;
  const config = AUTHENTICATED_MONITOR_SITES[siteId];
  try {
    const base = new URL(config.baseUrl);
    const parsed = new URL(location, base);
    if (parsed.origin !== base.origin) return location;
    return `${config.proxyPrefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return location;
  }
}

function serializeMonitorProxyBody(method: string, body: unknown, contentType: string): BodyInit | undefined {
  if (['GET', 'HEAD'].includes(method.toUpperCase()) || body == null) return undefined;
  if (typeof body === 'string' || body instanceof ArrayBuffer || Buffer.isBuffer(body)) return body as BodyInit;
  if (contentType.includes('application/x-www-form-urlencoded') && body && typeof body === 'object') {
    return new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')]));
  }
  return contentType.includes('application/json') && typeof body === 'object'
    ? JSON.stringify(body)
    : String(body);
}

export async function executeMonitorProxyRequest(
  siteId: AuthenticatedMonitorSiteId,
  input: MonitorProxyRequest,
): Promise<MonitorProxyResponse> {
  const config = AUTHENTICATED_MONITOR_SITES[siteId];
  const storedCookie = await getSettingString(config.cookieSettingKey);
  if (!storedCookie) throw new MissingMonitorCookieError(siteId);

  const wildcardPath = resolveMonitorProxyPath(siteId, input.requestUrl, input.wildcardPath || '');
  const targetUrl = new URL(`${config.baseUrl}/${wildcardPath}`);
  for (const [key, value] of Object.entries(input.query || {})) {
    if (value == null) continue;
    targetUrl.searchParams.set(key, String(value));
  }

  const contentType = input.headers.contentType || '';
  const upstreamHeaders: Record<string, string> = {
    cookie: storedCookie,
    accept: input.headers.accept || '*/*',
    'accept-language': input.headers.acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent': input.headers.userAgent || 'r-api-monitor-proxy/1.0',
  };
  if (contentType) upstreamHeaders['content-type'] = contentType;
  if (input.headers.referer) {
    upstreamHeaders.referer = input.headers.referer.replace(config.proxyPrefix, config.baseUrl);
  }

  const upstreamResponse = await fetch(targetUrl, {
    method: input.method.toUpperCase(),
    headers: upstreamHeaders,
    body: serializeMonitorProxyBody(input.method, input.body, contentType),
    redirect: 'manual',
  });
  const responseContentType = upstreamResponse.headers.get('content-type') || '';
  const textResponse = (
    responseContentType.includes('text/html')
    || responseContentType.includes('application/javascript')
    || responseContentType.includes('text/javascript')
    || responseContentType.includes('text/css')
    || responseContentType.includes('application/json')
  );
  return {
    status: upstreamResponse.status,
    contentType: responseContentType,
    cacheControl: upstreamResponse.headers.get('cache-control'),
    location: rewriteMonitorLocation(siteId, upstreamResponse.headers.get('location')),
    body: textResponse
      ? rewriteMonitorProxyText(siteId, await readRuntimeResponseText(
        upstreamResponse as unknown as Parameters<typeof readRuntimeResponseText>[0],
      ))
      : Buffer.from(await upstreamResponse.arrayBuffer()),
  };
}
