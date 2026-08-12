import { describe, expect, it } from 'vitest';
import { resolveLoginErrorMessage } from './loginError.js';

describe('resolveLoginErrorMessage', () => {
  it('returns IP allowlist hint when backend rejects by IP', () => {
    expect(resolveLoginErrorMessage(403, 'IP not allowed')).toBe('当前 IP 不在管理白名单中');
  });

  it('returns invalid token message for auth failures', () => {
    expect(resolveLoginErrorMessage(403, 'Invalid token')).toBe('登录凭据无效');
    expect(resolveLoginErrorMessage(401, 'Admin session required')).toBe('登录凭据无效');
    expect(resolveLoginErrorMessage(429, 'Too many requests')).toBe('登录尝试过于频繁，请稍后再试');
  });

  it('returns server error message for 5xx', () => {
    expect(resolveLoginErrorMessage(500, 'internal error')).toBe('服务端异常，请稍后重试');
  });
});
