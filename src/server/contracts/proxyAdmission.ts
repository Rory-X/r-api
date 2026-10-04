export type ProxyAdmissionError = Error & { localProxyAdmissionFailure: true; status: number; code: string };

/** Local policy/capacity failures never imply an upstream health failure or a send. */
export function getProxyAdmissionError(error: unknown): ProxyAdmissionError | null {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    if ((current as Partial<ProxyAdmissionError>).localProxyAdmissionFailure === true) return current as ProxyAdmissionError;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isProxyAdmissionError(error: unknown): error is ProxyAdmissionError { return getProxyAdmissionError(error) !== null; }
