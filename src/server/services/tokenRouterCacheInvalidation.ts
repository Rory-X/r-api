type TokenRouterCacheInvalidationListener = () => void;

const listeners = new Set<TokenRouterCacheInvalidationListener>();

export function subscribeTokenRouterCacheInvalidation(
  listener: TokenRouterCacheInvalidationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishTokenRouterCacheInvalidation(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[tokenRouter] cache invalidation listener failed', error);
    }
  }
}
