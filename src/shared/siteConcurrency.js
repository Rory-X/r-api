export const MAX_SITE_CONCURRENCY = 10_000;
export const MAX_SITE_CONCURRENCY_WAIT_MS = 60_000;

export function isValidSiteConcurrencyLimit(value) {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SITE_CONCURRENCY);
}

export function isValidSiteConcurrencyWait(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SITE_CONCURRENCY_WAIT_MS;
}

/** Missing fields in old payloads preserve their unlimited/no-wait defaults. */
export function validateSiteConcurrencyConfig(input) {
  if (input.maxConcurrency !== undefined && !isValidSiteConcurrencyLimit(input.maxConcurrency)) return 'maxConcurrency';
  if (input.concurrencyWaitTimeoutMs !== undefined && !isValidSiteConcurrencyWait(input.concurrencyWaitTimeoutMs)) return 'concurrencyWaitTimeoutMs';
  return null;
}
