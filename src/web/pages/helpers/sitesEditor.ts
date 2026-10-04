import { validateSiteConcurrencyConfig } from '../../../shared/siteConcurrency.js';
export type SiteCustomHeaderField = {
  key: string;
  value: string;
};

export type SiteApiEndpointField = {
  draftId?: string;
  url: string;
  enabled: boolean;
  cooldownUntil?: string | null;
  lastFailureReason?: string | null;
};

export type SiteForm = {
  name: string;
  url: string;
  homepageUrl: string;
  externalCheckinUrl: string;
  platform: string;
  proxyUrl: string;
  useSystemProxy: boolean;
  codexFingerprintEnabled: boolean;
  apiEndpoints: SiteApiEndpointField[];
  customHeaders: SiteCustomHeaderField[];
  customHeadersOverrideRequestHeaders: boolean;
  globalWeight: string;
  maxConcurrency: string;
  concurrencyWaitTimeoutMs: string;
};

export type SiteEditorState =
  | { mode: 'add' }
  | { mode: 'edit'; editingSiteId: number };

export type SiteSavePayload = {
  name: string;
  url: string;
  homepageUrl: string;
  externalCheckinUrl: string;
  platform: string;
  initializationPresetId?: string | null;
  proxyUrl: string;
  useSystemProxy: boolean;
  codexFingerprintEnabled: boolean;
  apiEndpoints: Array<{
    url: string;
    enabled: boolean;
    sortOrder: number;
  }>;
  customHeaders: string;
  customHeadersOverrideRequestHeaders: boolean;
  globalWeight: number;
  maxConcurrency?: number | null;
  concurrencyWaitTimeoutMs?: number;
  postRefreshProbeEnabled?: boolean;
  postRefreshProbeModel?: string;
  postRefreshProbeScope?: 'single' | 'all';
  postRefreshProbeLatencyThresholdMs?: number;
};

type SiteSaveAction =
  | { kind: 'add'; payload: SiteSavePayload }
  | { kind: 'update'; id: number; payload: SiteSavePayload };

export function emptySiteCustomHeader(): SiteCustomHeaderField {
  return { key: '', value: '' };
}

export function emptySiteApiEndpoint(): SiteApiEndpointField {
  return {
    url: '',
    enabled: true,
    cooldownUntil: null,
    lastFailureReason: null,
  };
}

function ensureSiteCustomHeaderRows(rows: SiteCustomHeaderField[]): SiteCustomHeaderField[] {
  return rows.length > 0 ? rows : [emptySiteCustomHeader()];
}

export function emptySiteForm(): SiteForm {
  return {
    name: '',
    url: '',
    homepageUrl: '',
    externalCheckinUrl: '',
    platform: '',
    proxyUrl: '',
    useSystemProxy: false,
    codexFingerprintEnabled: false,
    apiEndpoints: [emptySiteApiEndpoint()],
    customHeaders: [emptySiteCustomHeader()],
    customHeadersOverrideRequestHeaders: false,
    globalWeight: '1',
    maxConcurrency: '',
    concurrencyWaitTimeoutMs: '0',
  };
}

function ensureSiteApiEndpointRows(rows: SiteApiEndpointField[]): SiteApiEndpointField[] {
  return rows.length > 0 ? rows : [emptySiteApiEndpoint()];
}

function parseCustomHeadersForEditor(raw: unknown): SiteCustomHeaderField[] {
  if (typeof raw !== 'string') {
    return ensureSiteCustomHeaderRows([]);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return ensureSiteCustomHeaderRows([]);
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ensureSiteCustomHeaderRows([]);
    }
    return ensureSiteCustomHeaderRows(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : String(value ?? ''),
      })),
    );
  } catch {
    return ensureSiteCustomHeaderRows([]);
  }
}

function parseApiEndpointsForEditor(raw: unknown): SiteApiEndpointField[] {
  if (!Array.isArray(raw)) {
    return ensureSiteApiEndpointRows([]);
  }

  const rows: SiteApiEndpointField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    rows.push({
      url: typeof row.url === 'string' ? row.url : '',
      enabled: row.enabled !== false,
      cooldownUntil: typeof row.cooldownUntil === 'string' ? row.cooldownUntil : null,
      lastFailureReason: typeof row.lastFailureReason === 'string' ? row.lastFailureReason : null,
    });
  }
  return ensureSiteApiEndpointRows(rows);
}

export function siteFormFromSite(site: Partial<Omit<SiteForm, 'apiEndpoints' | 'customHeaders' | 'customHeadersOverrideRequestHeaders' | 'globalWeight' | 'homepageUrl' | 'externalCheckinUrl' | 'proxyUrl' | 'useSystemProxy' | 'codexFingerprintEnabled' | 'maxConcurrency' | 'concurrencyWaitTimeoutMs'>> & {
  homepageUrl?: string | null;
  externalCheckinUrl?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean | null;
  codexFingerprintEnabled?: boolean | null;
  apiEndpoints?: Array<{
    url?: string | null;
    enabled?: boolean | null;
    cooldownUntil?: string | null;
    lastFailureReason?: string | null;
  }> | null;
  customHeaders?: string | null;
  customHeadersOverrideRequestHeaders?: boolean | null;
  globalWeight?: number | string | null;
  maxConcurrency?: number | null;
  concurrencyWaitTimeoutMs?: number | null;
}): SiteForm {
  const globalWeightRaw = Number(site.globalWeight);
  const globalWeight = Number.isFinite(globalWeightRaw) && globalWeightRaw > 0 ? String(globalWeightRaw) : '1';
  return {
    name: site.name ?? '',
    url: site.url ?? '',
    homepageUrl: site.homepageUrl ?? '',
    externalCheckinUrl: site.externalCheckinUrl ?? '',
    platform: site.platform ?? '',
    proxyUrl: site.proxyUrl ?? '',
    useSystemProxy: !!site.useSystemProxy,
    codexFingerprintEnabled: !!site.codexFingerprintEnabled,
    apiEndpoints: parseApiEndpointsForEditor(site.apiEndpoints),
    customHeaders: parseCustomHeadersForEditor(site.customHeaders),
    customHeadersOverrideRequestHeaders: !!site.customHeadersOverrideRequestHeaders,
    globalWeight,
    maxConcurrency: site.maxConcurrency == null ? '' : String(site.maxConcurrency),
    concurrencyWaitTimeoutMs: String(site.concurrencyWaitTimeoutMs ?? 0),
  };
}

// Keep this in sync with normalizeSiteApiEndpointBaseUrl in
// src/server/services/siteApiEndpointService.ts.
function normalizeSiteApiEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function serializeSiteCustomHeaders(fields: SiteCustomHeaderField[]): {
  valid: boolean;
  customHeaders: string;
  error?: string;
} {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();

  for (const field of fields) {
    const key = field.key.trim();
    const value = field.value;
    const hasAnyInput = key.length > 0 || value.trim().length > 0;
    if (!hasAnyInput) continue;
    if (!key) {
      return { valid: false, customHeaders: '', error: '请求头名称不能为空' };
    }
    const normalizedKey = key.toLowerCase();
    if (seen.has(normalizedKey)) {
      return { valid: false, customHeaders: '', error: `请求头 "${key}" 重复了` };
    }
    seen.add(normalizedKey);
    headers[key] = value;
  }

  return {
    valid: true,
    customHeaders: Object.keys(headers).length > 0 ? JSON.stringify(headers) : '',
  };
}

export function serializeSiteApiEndpoints(fields: SiteApiEndpointField[]): {
  valid: boolean;
  apiEndpoints: Array<{
    url: string;
    enabled: boolean;
    sortOrder: number;
  }>;
  error?: string;
} {
  const apiEndpoints: Array<{
    url: string;
    enabled: boolean;
    sortOrder: number;
  }> = [];
  const seen = new Set<string>();

  for (const field of fields) {
    const rawUrl = field.url.trim();
    if (!rawUrl) continue;
    const normalizedUrl = normalizeSiteApiEndpointUrl(rawUrl);
    if (!normalizedUrl) continue;
    if (seen.has(normalizedUrl)) {
      return {
        valid: false,
        apiEndpoints: [],
        error: `API 请求地址 "${normalizedUrl}" 重复了`,
      };
    }
    seen.add(normalizedUrl);
    apiEndpoints.push({
      url: normalizedUrl || rawUrl,
      enabled: field.enabled !== false,
      sortOrder: apiEndpoints.length,
    });
  }

  return {
    valid: true,
    apiEndpoints,
  };
}

export function buildSiteSaveAction(editor: SiteEditorState, form: SiteSavePayload): SiteSaveAction {
  if (editor.mode === 'edit') {
    if (!Number.isFinite(editor.editingSiteId)) {
      throw new Error('editingSiteId is required in edit mode');
    }
    return { kind: 'update', id: editor.editingSiteId, payload: form };
  }
  return { kind: 'add', payload: form };
}

export function serializeSiteConcurrency(form: Pick<SiteForm, 'maxConcurrency' | 'concurrencyWaitTimeoutMs'>):
  { valid: true; maxConcurrency: number | null; concurrencyWaitTimeoutMs: number } | { valid: false; error: string } {
  const maxConcurrency = form.maxConcurrency.trim() === '' ? null : Number(form.maxConcurrency);
  const concurrencyWaitTimeoutMs = form.concurrencyWaitTimeoutMs.trim() === '' ? NaN : Number(form.concurrencyWaitTimeoutMs);
  const invalidField = validateSiteConcurrencyConfig({ maxConcurrency, concurrencyWaitTimeoutMs });
  if (invalidField) return { valid: false, error: invalidField === 'maxConcurrency' ? '站点总并发必须留空或填写 1–10000 的整数' : '并发等待时间必须是 0–60000 毫秒的整数' };
  return { valid: true, maxConcurrency, concurrencyWaitTimeoutMs };
}
