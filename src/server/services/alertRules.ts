import {
  isCloudflareChallengeMessage,
  isTokenExpiredMessage,
} from './operationalFailureContract.js';

export function isCloudflareChallenge(message?: string | null): boolean {
  return isCloudflareChallengeMessage(message);
}

const SESSION_TOKEN_REBIND_HINT = '请在中转站重新生成系统访问令牌后重新绑定账号';

function isEndpointDispatchDeniedMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(message)
    || text.includes('dispatch denied')
  );
}

function containsHttpStatus(message: string | null | undefined, status: number): boolean {
  if (!message) return false;
  return new RegExp(`(?:^|\\b)(?:http\\s*)?${status}(?:\\b|:)`, 'i').test(message);
}

export function isTokenExpiredError(input: { status?: number; message?: string | null }): boolean {
  const rawMessage = input.message || '';
  if (isEndpointDispatchDeniedMessage(rawMessage)) return false;
  if (containsHttpStatus(rawMessage, 401)) return true;
  return isTokenExpiredMessage(input);
}

export function appendSessionTokenRebindHint(message?: string | null): string {
  const raw = String(message || '').trim();
  if (!raw) return raw;
  if (raw.includes(SESSION_TOKEN_REBIND_HINT)) return raw;

  const text = raw.toLowerCase();
  const looksLikeInvalidAccessToken = (
    raw.includes('无权进行此操作，access token 无效') ||
    /invalid\s+access\s+token/.test(text) ||
    /access\s+token\s+is\s+invalid/.test(text) ||
    /access\s+token.*无效/.test(raw)
  );
  if (!looksLikeInvalidAccessToken) return raw;

  return `${raw}，${SESSION_TOKEN_REBIND_HINT}`;
}
