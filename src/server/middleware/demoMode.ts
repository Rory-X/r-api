const DEMO_WRITE_ALLOWLIST = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/totp/verify',
]);

const DEMO_PROXY_PATH_PREFIXES = [
  '/chat/completions',
  '/gemini/',
  '/responses',
  '/v1',
  '/v1beta',
  '/v1internal',
];

function requestPath(url: string): string {
  return String(url || '').split('?')[0] || '/';
}

function isSafeMethod(method: string): boolean {
  const normalized = String(method || '').trim().toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS';
}

export function isDemoModeRequestBlocked(method: string, url: string): boolean {
  const path = requestPath(url);
  if (DEMO_PROXY_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return true;
  }
  if (isSafeMethod(method)) return false;
  return !DEMO_WRITE_ALLOWLIST.has(path);
}

export const DEMO_MODE_BLOCK_RESPONSE = {
  success: false,
  code: 'DEMO_READ_ONLY',
  message: '公共演示站为只读模式，不会保存修改或转发 API 请求',
} as const;
