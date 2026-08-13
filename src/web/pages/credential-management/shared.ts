import type {
  CredentialLifecycleEntityType,
  CredentialLifecycleItem,
  CredentialLifecycleStatus,
} from '../../api.js';

export type SiteRow = {
  id: number;
  name: string;
  platform: string;
  url?: string;
};

export const KIND_LABELS: Record<string, string> = {
  session_token: 'Session / JWT',
  cookie: '浏览器 Cookie',
  browser_storage: '浏览器 Storage',
  oauth_token_set: 'OAuth Token Set',
  oauth_access_token: 'OAuth Access Token',
  oauth_refresh_token: 'OAuth Refresh Token',
  api_key: 'API Key',
  integration_secret: '系统集成密钥',
  username_password: '用户名密码',
  metadata_only: '仅元数据',
};

export const LIFECYCLE_STATUS_LABELS: Record<CredentialLifecycleStatus, string> = {
  active: '可用',
  expiring: '即将过期',
  expired: '已过期',
  refreshing: '刷新中',
  refresh_failed: '刷新失败',
  revoked: '已撤销',
  invalid: '不可用',
  disabled: '已停用',
  metadata_only: '仅元数据',
};

export const ENTITY_LABELS: Record<CredentialLifecycleEntityType, string> = {
  account: '连接账号',
  vault_item: 'Vault',
};

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

export function maskFingerprint(value?: string | null): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
}

export function lifecycleKey(item: Pick<CredentialLifecycleItem, 'entityType' | 'entityId'>): string {
  return `${item.entityType}:${item.entityId}`;
}

export function lifecycleStatusColor(status: CredentialLifecycleStatus): string {
  if (status === 'active') return 'var(--color-success)';
  if (status === 'refreshing') return 'var(--color-primary)';
  if (status === 'expiring' || status === 'refresh_failed') return 'var(--color-warning)';
  if (status === 'invalid' || status === 'expired' || status === 'revoked') return 'var(--color-danger)';
  return 'var(--color-text-muted)';
}

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportFilename(mode: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = mode === 'metadata_only'
    ? 'metadata'
    : mode === 'encrypted_backup'
      ? 'encrypted-backup'
      : 'portable-secrets';
  return `r-api-credentials-${suffix}-${date}.json`;
}
