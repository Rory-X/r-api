function normalizeReason(reason: string): string {
  return (reason || '').trim().toLowerCase();
}

export function resolveLoginErrorMessage(status: number, reason: string): string {
  const normalizedReason = normalizeReason(reason);
  if (status === 403 && normalizedReason.includes('ip not allowed')) {
    return '当前 IP 不在管理白名单中';
  }
  if (status === 429) {
    return '登录尝试过于频繁，请稍后再试';
  }
  if (status === 401 || (status === 403 && normalizedReason.includes('invalid token'))) {
    return '登录凭据无效';
  }
  if (status >= 500) {
    return '服务端异常，请稍后重试';
  }
  return '登录失败，请检查服务状态';
}
