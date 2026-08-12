import React, { useEffect, useMemo, useState } from 'react';
import { api, type CredentialVaultItem, type SiteAdapterContract } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import { useToast } from '../components/Toast.js';
import { Button, Input, Option, Select, TextArea } from '../components/ui/index.js';

type SiteRow = {
  id: number;
  name: string;
  platform: string;
  url?: string;
};

const KIND_LABELS: Record<string, string> = {
  session_token: 'Session / JWT',
  cookie: '浏览器 Cookie',
  browser_storage: '浏览器 Storage',
  oauth_access_token: 'OAuth Access Token',
  oauth_refresh_token: 'OAuth Refresh Token',
  api_key: '兼容网关 API Key',
  integration_secret: '系统集成密钥',
};

const STATUS_LABELS: Record<CredentialVaultItem['status'], string> = {
  active: '可用',
  revoked: '已撤销',
  expired: '已过期',
};

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function maskFingerprint(value: string): string {
  return value.length > 16 ? value.slice(0, 12) + '…' + value.slice(-4) : value;
}

function toIsoOrNull(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export default function CredentialVault() {
  const toast = useToast();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [contracts, setContracts] = useState<SiteAdapterContract[]>([]);
  const [items, setItems] = useState<CredentialVaultItem[]>([]);
  const [siteFilter, setSiteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<CredentialVaultItem['status'] | ''>('');
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [kind, setKind] = useState('');
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('');
  const [origin, setOrigin] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const contractByPlatform = useMemo(
    () => new Map(contracts.map((contract) => [contract.platformName, contract])),
    [contracts],
  );
  const selectedSite = sites.find((site) => String(site.id) === siteId);
  const selectedContract = selectedSite ? contractByPlatform.get(selectedSite.platform) : undefined;
  const availableKinds = selectedContract?.credentialKinds || [];

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  };

  const loadMetadata = async () => {
    setLoading(true);
    try {
      const [siteRows, contractResponse] = await Promise.all([
        api.getSites(),
        api.getSiteAdapterContracts(),
      ]);
      setSites(Array.isArray(siteRows) ? siteRows : []);
      setContracts(Array.isArray(contractResponse?.adapters) ? contractResponse.adapters : []);
    } catch (error: any) {
      toast.error(error?.message || '加载凭证中心配置失败');
    } finally {
      setLoading(false);
    }
  };

  const loadItems = async () => {
    setItemsLoading(true);
    try {
      const response = await api.getCredentialVaultItems({
        siteId: siteFilter ? Number(siteFilter) : undefined,
        status: statusFilter || undefined,
      });
      setItems(Array.isArray(response?.items) ? response.items : []);
    } catch (error: any) {
      toast.error(error?.message || '加载凭证失败');
    } finally {
      setItemsLoading(false);
    }
  };

  useEffect(() => {
    void loadMetadata();
  }, []);

  useEffect(() => {
    void loadItems();
  }, [siteFilter, statusFilter]);

  useEffect(() => {
    if (!availableKinds.includes(kind)) {
      setKind(availableKinds[0] || '');
    }
  }, [availableKinds, kind]);

  const resetForm = () => {
    setName('');
    setSiteId('');
    setKind('');
    setSecret('');
    setUsername('');
    setOrigin('');
    setExpiresAt('');
  };

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!siteId || !kind || !name.trim() || !secret.trim()) {
      toast.error('请填写站点、名称、类型和凭证内容');
      return;
    }
    setSaving(true);
    try {
      await api.createCredentialVaultItem({
        siteId: Number(siteId),
        name: name.trim(),
        kind,
        secret,
        metadata: {
          source: kind === 'browser_storage' || kind === 'cookie' ? 'browser' : 'manual',
          username: username.trim() || undefined,
          origin: origin.trim() || undefined,
          adapterPlatform: selectedSite?.platform,
        },
        expiresAt: toIsoOrNull(expiresAt),
      });
      toast.success('凭证已安全保存');
      setShowCreate(false);
      resetForm();
      await loadItems();
    } catch (error: any) {
      toast.error(error?.message || '保存凭证失败');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (id: number) => {
    setWorkingId(id);
    try {
      await api.revokeCredentialVaultItem(id);
      toast.success('凭证已撤销');
      await loadItems();
    } catch (error: any) {
      toast.error(error?.message || '撤销凭证失败');
    } finally {
      setWorkingId(null);
    }
  };

  const remove = async (id: number) => {
    setWorkingId(id);
    try {
      await api.deleteCredentialVaultItem(id);
      toast.success('凭证已删除');
      await loadItems();
    } catch (error: any) {
      toast.error(error?.message || '删除凭证失败');
    } finally {
      setWorkingId(null);
    }
  };

  if (loading) {
    return (
      <div className="animate-fade-in">
        <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: '100%', height: 240, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in" style={{ paddingBottom: 40 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title">凭证中心</h2>
          <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
            统一治理站点、账号和系统集成使用的加密凭证；管理接口仅返回指纹和元数据。
          </div>
        </div>
        <div className="page-actions">
          <Button className="btn btn-primary" onClick={() => setShowCreate(true)}>添加站点凭证</Button>
        </div>
      </div>

      <div className="management-page-stack" style={{ gap: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)} style={{ width: 240 }}>
            <Option value="">全部归属</Option>
            {sites.map((site) => <Option key={site.id} value={site.id}>{site.name} · {site.platform}</Option>)}
          </Select>
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CredentialVaultItem['status'] | '')} style={{ width: 160 }}>
            <Option value="">全部状态</Option>
            <Option value="active">可用</Option>
            <Option value="revoked">已撤销</Option>
            <Option value="expired">已过期</Option>
          </Select>
          <span style={{ alignSelf: 'center', color: 'var(--color-text-muted)', fontSize: 12 }}>
            {itemsLoading ? '刷新中…' : String(items.length) + ' 条'}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="card" style={{ padding: 28, color: 'var(--color-text-muted)', fontSize: 13 }}>
            暂无凭证
          </div>
        ) : (
          items.map((item) => {
            const site = sites.find((row) => row.id === item.siteId);
            const ownerLabel = site
              ? `站点：${site.name}`
              : item.accountId
                ? `账号：#${item.accountId}`
                : '归属：系统集成';
            const metadataLabels = item.metadata
              ? [
                item.metadata.adapterPlatform,
                item.metadata.purpose,
                item.metadata.username,
                item.metadata.origin,
                item.metadata.source,
              ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
              : [];
            return (
              <div key={item.id} className="card" style={{ padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{item.name}</strong>
                      <span style={{ fontSize: 11, color: item.status === 'active' ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                        {STATUS_LABELS[item.status]}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{KIND_LABELS[item.kind] || item.kind}</span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                      <span>{ownerLabel}</span>
                      <span>指纹：<code>{maskFingerprint(item.fingerprint)}</code></span>
                      <span>更新时间：{formatDate(item.updatedAt || item.createdAt)}</span>
                    </div>
                    {metadataLabels.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>
                        {metadataLabels.join(' · ')}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    {item.status === 'active' && (
                      <Button className="btn btn-secondary" disabled={workingId === item.id} onClick={() => void revoke(item.id)}>
                        {workingId === item.id ? '处理中…' : '撤销'}
                      </Button>
                    )}
                    <Button className="btn btn-ghost" disabled={workingId === item.id} onClick={() => void remove(item.id)}>
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <CenteredModal
        open={showCreate}
        onClose={() => { if (!saving) setShowCreate(false); }}
        title="添加站点凭证"
        maxWidth={620}
        closeOnBackdrop={!saving}
        closeOnEscape={!saving}
        bodyStyle={{ maxHeight: 'calc(90vh - 150px)', overflowY: 'auto' }}
        footer={(
          <>
            <Button type="button" variant="ghost" disabled={saving} onClick={() => setShowCreate(false)}>取消</Button>
            <Button type="submit" form="credential-vault-create-form" variant="primary" loading={saving} loadingLabel="保存中…">
              安全保存
            </Button>
          </>
        )}
      >
          <form id="credential-vault-create-form" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} onSubmit={submitCreate}>
            <label style={{ fontSize: 13 }}>
              站点
              <Select value={siteId} onChange={(event) => setSiteId(event.target.value)} style={{ width: '100%', marginTop: 6 }}>
                <Option value="">请选择站点</Option>
                {sites.map((site) => <Option key={site.id} value={site.id}>{site.name} · {site.platform}</Option>)}
              </Select>
            </label>
            <label style={{ fontSize: 13 }}>
              凭证类型
              <Select value={kind} onChange={(event) => setKind(event.target.value)} style={{ width: '100%', marginTop: 6 }} disabled={!siteId}>
                <Option value="">{siteId ? '请选择类型' : '先选择站点'}</Option>
                {availableKinds.map((value) => <Option key={value} value={value}>{KIND_LABELS[value] || value}</Option>)}
              </Select>
            </label>
            {selectedContract?.browser.supported && (
              <div style={{ padding: '8px 10px', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-muted)', fontSize: 12 }}>
                浏览器凭证模式：{selectedContract.browser.modes.join(' / ')} · 任务 TTL {selectedContract.browser.taskTtlSec}s
              </div>
            )}
            <label style={{ fontSize: 13 }}>
              名称
              <Input value={name} onChange={(event) => setName(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="例如：主账号 Session" />
            </label>
            <label style={{ fontSize: 13 }}>
              凭证内容
              <TextArea value={secret} onChange={(event) => setSecret(event.target.value)} style={{ ...inputStyle, marginTop: 6, minHeight: 100, resize: 'vertical' }} placeholder="不会回显到列表或 API 响应" />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label style={{ fontSize: 13 }}>
                用户名（可选）
                <Input value={username} onChange={(event) => setUsername(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} />
              </label>
              <label style={{ fontSize: 13 }}>
                Origin（可选）
                <Input value={origin} onChange={(event) => setOrigin(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="https://site.example.com" />
              </label>
            </div>
            <label style={{ fontSize: 13 }}>
              到期时间（可选）
              <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} />
            </label>
          </form>
      </CenteredModal>
    </div>
  );
}
