import { refreshOauthAccessToken } from './service.js';
import type { RefreshOauthAccessTokenOptions } from './refreshCoordinator.js';

const refreshInFlight = new Map<number, Promise<Awaited<ReturnType<typeof refreshOauthAccessToken>>>>();

export async function refreshOauthAccessTokenSingleflight(
  accountId: number,
  options: RefreshOauthAccessTokenOptions = {},
) {
  const existing = refreshInFlight.get(accountId);
  if (existing) {
    return existing;
  }

  const promise = refreshOauthAccessToken(accountId, options).finally(() => {
    refreshInFlight.delete(accountId);
  });
  refreshInFlight.set(accountId, promise);
  return promise;
}
