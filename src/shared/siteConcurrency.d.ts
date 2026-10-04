export const MAX_SITE_CONCURRENCY: 10000;
export const MAX_SITE_CONCURRENCY_WAIT_MS: 60000;
export function isValidSiteConcurrencyLimit(value: unknown): value is number | null;
export function isValidSiteConcurrencyWait(value: unknown): value is number;
export function validateSiteConcurrencyConfig(input: { maxConcurrency?: unknown; concurrencyWaitTimeoutMs?: unknown }): 'maxConcurrency' | 'concurrencyWaitTimeoutMs' | null;
