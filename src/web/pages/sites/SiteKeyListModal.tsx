import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { resolveAccountCredentialMode } from '../helpers/accountConnection.js';
import { formatDateTimeLocal } from '../helpers/checkinLogTime.js';

type SiteKeyListSite = {
  id: number;
  name: string;
  url?: string | null;
  platform?: string | null;
};

type SiteApiKeyConnection = {
  id: number;
  siteId?: number | null;
  username?: string | null;
  status?: string | null;
  createdAt?: string | null;
  credentialMode?: string | null;
  capabilities?: { proxyOnly?: boolean } | null;
  accessToken?: string | null;
  site?: { id?: number | null } | null;
};

type SiteKeyListModalProps = {
  open: boolean;
  site: SiteKeyListSite | null;
  onClose: () => void;
  onAddKey: (site: SiteKeyListSite) => void;
  onOpenKey: (accountId: number) => void;
};

function resolveConnectionName(account: SiteApiKeyConnection): string {
  const username = typeof account.username === 'string' ? account.username.trim() : '';
  return username || `API Key 连接 #${account.id}`;
}

function resolveStatusPresentation(status?: string | null) {
  if (status === 'disabled') return { label: '已禁用', className: 'badge-muted' };
  if (status === 'expired') return { label: '已失效', className: 'badge-warning' };
  return { label: '启用中', className: 'badge-success' };
}

export default function SiteKeyListModal({
  open,
  site,
  onClose,
  onAddKey,
  onOpenKey,
}: SiteKeyListModalProps) {
  const lastSiteRef = useRef<SiteKeyListSite | null>(site);
  const [keys, setKeys] = useState<SiteApiKeyConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  if (site) lastSiteRef.current = site;
  const activeSite = site || lastSiteRef.current;

  useEffect(() => {
    if (!open || !site) return;

    let cancelled = false;
    setLoading(true);
    setError('');

    api.getAccountsSnapshot({ refresh: true })
      .then((snapshot: { accounts?: SiteApiKeyConnection[] } | null | undefined) => {
        if (cancelled) return;
        const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
        const nextKeys = accounts.filter((account) => {
          const accountSiteId = Number(account.siteId || account.site?.id || 0);
          return accountSiteId === site.id && resolveAccountCredentialMode(account) === 'apikey';
        });
        setKeys(nextKeys);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setKeys([]);
        setError(reason instanceof Error && reason.message ? reason.message : 'Key 列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, reloadKey, site]);

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={(
        <div className="site-key-list-title">
          <span>{activeSite?.name || '站点'} · Key 列表</span>
          <span>{loading ? '加载中' : `${keys.length} 个 Key`}</span>
        </div>
      )}
      maxWidth={720}
      bodyStyle={{ maxHeight: '66vh', overflowY: 'auto' }}
      footer={(
        <>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
            关闭
          </button>
          <button
            type="button"
            onClick={() => activeSite && onAddKey(activeSite)}
            disabled={!activeSite}
            className="btn btn-primary"
          >
            + 添加 Key
          </button>
        </>
      )}
    >
      <div className="site-key-list-summary">
        <div>
          <div className="site-key-list-summary-label">当前站点</div>
          <div className="site-key-list-summary-value">{activeSite?.name || '-'}</div>
        </div>
        <span className="badge badge-info">{activeSite?.platform || '未识别平台'}</span>
      </div>

      {loading ? (
        <div className="site-key-list-state">
          <span className="spinner" />
          正在加载 Key 列表...
        </div>
      ) : error ? (
        <div className="site-key-list-state site-key-list-state-error">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((current) => current + 1)} className="btn btn-link btn-link-primary">
            重新加载
          </button>
        </div>
      ) : keys.length === 0 ? (
        <div className="site-key-list-empty">
          <div className="site-key-list-empty-icon" aria-hidden="true">⌁</div>
          <div className="empty-state-title">该站点还没有 API Key</div>
          <div className="empty-state-desc">点击下方“添加 Key”创建第一条代理连接。</div>
        </div>
      ) : (
        <div className="site-key-list-items">
          {keys.map((account) => {
            const status = resolveStatusPresentation(account.status);
            return (
              <div key={account.id} className="site-key-list-item">
                <div className="site-key-list-item-main">
                  <div className="site-key-list-item-heading">
                    <span className="site-key-list-item-name">{resolveConnectionName(account)}</span>
                    <span className={`badge ${status.className}`}>{status.label}</span>
                  </div>
                  <div className="site-key-list-item-meta">
                    <span>连接 ID #{account.id}</span>
                    <span>创建于 {formatDateTimeLocal(account.createdAt)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenKey(account.id)}
                  className="btn btn-ghost site-key-list-manage-button"
                >
                  定位管理
                </button>
              </div>
            );
          })}
        </div>
      )}
    </CenteredModal>
  );
}
