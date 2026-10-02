const SENSITIVE_KEY = /^(?:api[-_]?key|access[-_]?token|auth|authorization|key|password|secret|token)$/i;
const URL_PATTERN = /\b(?:https?|mysql|postgres|postgresql):\/\/[^\s)\]}>,]+/gi;

function redactUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = 'redacted';
    if (parsed.password) parsed.password = 'redacted';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, 'redacted');
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

export function redactOperationalMessage(value: unknown, maxLength = 500): string {
  const raw = value instanceof Error ? value.message : String(value || 'unknown error');
  return raw
    .replace(URL_PATTERN, redactUrl)
    .replace(
      /\b(api[-_]?key|access[-_]?token|auth|authorization|key|password|secret|token)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=redacted',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, maxLength)) || 'unknown error';
}
