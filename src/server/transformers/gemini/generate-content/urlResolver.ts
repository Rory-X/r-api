function normalizePathname(pathname: string): string {
  let normalized = pathname || '';
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function splitBaseUrl(baseUrl: string): { path: string; query: string } {
  const raw = baseUrl || '';
  const queryIndex = raw.indexOf('?');
  if (queryIndex < 0) {
    return { path: normalizePathname(raw).replace(/\/openai$/i, ''), query: '' };
  }
  return {
    path: normalizePathname(raw.slice(0, queryIndex)).replace(/\/openai$/i, ''),
    query: raw.slice(queryIndex + 1),
  };
}

function baseIncludesVersion(path: string): boolean {
  return /\/v\d+(?:beta)?(?:\/|$)/i.test(path);
}

export function resolveGeminiNativeBaseUrl(baseUrl: string, apiVersion: string): string {
  const { path, query } = splitBaseUrl(baseUrl);
  const normalizedPath = baseIncludesVersion(path)
    ? path
    : `${path}/${apiVersion.replace(/^\/+/, '')}`;
  return `${normalizedPath}${query ? `?${query}` : ''}`;
}

export function resolveGeminiModelsUrl(
  baseUrl: string,
  apiVersion: string,
  apiKey: string,
): string {
  const base = resolveGeminiNativeBaseUrl(baseUrl, apiVersion);
  const [path, query = ''] = base.split('?', 2);
  const params = new URLSearchParams(query);
  params.set('key', apiKey);
  return `${path}/models?${params.toString()}`;
}

export function resolveGeminiGenerateContentUrl(
  baseUrl: string,
  apiVersion: string,
  modelActionPath: string,
  apiKey: string | undefined,
  search: string,
): string {
  const base = resolveGeminiNativeBaseUrl(baseUrl, apiVersion);
  const normalizedAction = modelActionPath.replace(/^\/+/, '');
  const [path, baseQuery = ''] = base.split('?', 2);
  const params = new URLSearchParams(baseQuery);
  const extraParams = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [key, value] of extraParams) {
    params.set(key, value);
  }
  if (apiKey !== undefined) params.set('key', apiKey);
  else for (const key of [...params.keys()]) { if (key.toLowerCase() === 'key') params.delete(key); }
  const query = params.toString();
  return `${path}/${normalizedAction}${query ? `?${query}` : ''}`;
}
