import React, { useEffect, useMemo, useState } from 'react';
import { api, type CredentialVaultItem, type SiteAdapterContract } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { useToast } from '../../components/Toast.js';
import { Button, Input, Option, Select, TextArea, useConfirmDialog } from '../../components/ui/index.js';
import { KIND_LABELS, formatDate, maskFingerprint, type SiteRow } from './shared.js';

type Props = {
  sites: SiteRow[];
  contracts: SiteAdapterContract[];
  refreshToken: number;
  onChanged: () => void;
};

const STATUS_LABELS: Record<CredentialVaultItem['status'], string> = {
  active: '可用',
  disabled: '已停用',
  revoked: '已撤销',
  expired: '已过期',
};

function toIsoOrNull(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export default function VaultInventoryPanel({ sites, contracts, refreshToken, onChanged }: Props) {
  const toast = useToast();
  const { requestConfirmation, confirmationDialog } = useConfirmDialog();
  const [items, setItems] = useState<CredentialVaultItem[]>([]);
  const [siteFilter, setSiteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<CredentialVaultItem['status'] | ''>('');
  const [loading, setLoading] = useState(true);
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

  const load = async () => {
    setLoading(true);
    try {
      const response = await api.getCredentialVaultItems({
        siteId: siteFilter ? Number(siteFilter) : undefined,
        status: statusFilter || undefined,
      });
      setItems(Array.isArray(response?.items) ? response.items : []);
    } catch (error: any) {
      toast.error(error?.message || '加载 Vault 凭证失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [siteFilter, statusFilter, refreshToken]);

  useEffect(() => {
    if (!availableKinds.includes(kind)) setKind(availableKinds[0] || '');
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
      await load();
      onChanged();
    } catch (error: any) {
      toast.error(error?.message || '保存凭证失败');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (item: CredentialVaultItem) => {
    const confirmed = await requestConfirmation({
      title: '撤销 Vault 凭证',
      description: `将撤销“${item.name}”，撤销后不会再作为可用凭证。`,
      confirmLabel: '确认撤销',
      confirmVariant: 'danger',
    });
    if (!confirmed) return;
    setWorkingId(item.id);
    try {
      await api.revokeCredentialVaultItem(item.id);
      toast.success('凭证已撤销');
      await load();
      onChanged();
    } catch (error: any) {
      toast.error(error?.message || '撤销凭证失败');
    } finally {
      setWorkingId(null);
    }
  };

  const remove = async (item: CredentialVaultItem) => {
    const confirmed = await requestConfirmation({
      title: '删除 Vault 凭证',
      description: `将永久删除“${item.name}”及其加密内容，此操作不可撤销。`,
      confirmLabel: '永久删除',
      confirmVariant: 'danger',
    });
    if (!confirmed) return;
    setWorkingId(item.id);
    try {
      await api.deleteCredentialVaultItem(item.id);
      toast.success('凭证已删除');
      await load();
      onChanged();
    } catch (error: any) {
      toast.error(error?.message || '删除凭证失败');
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <div className="management-page-stack" style={{ gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <Select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)} style={{ width: 240 }} aria-label="Vault 站点筛选">
            <Option value="">全部归属</Option>
            {sites.map((site) => <Option key={site.id} value={site.id}>{site.name} · {site.platform}</Option>)}
          </Select>
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CredentialVaultItem['status'] | '')} style={{ width: 160 }} aria-label="Vault 状态筛选">
            <Option value="">全部状态</Option>
            <Option value="active">可用</Option>
            <Option value="disabled">已停用</Option>
            <Option value="revoked">已撤销</Option>
            <Option value="expired">已过期</Option>
          </Select>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{loading ? '刷新中…' : `${items.length} 条`}</span>
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>添加站点凭证</Button>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 24 }}><div className="skeleton" style={{ height: 160 }} /></div>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: 28, color: 'var(--color-text-muted)', fontSize: 13 }}>暂无 Vault 凭证</div>
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
                    <span style={{ fontSize: 11, color: item.status === 'active' ? 'var(--color-success)' : 'var(--color-text-muted)' }}>{STATUS_LABELS[item.status]}</span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{KIND_LABELS[item.kind] || item.kind}</span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    <span>{ownerLabel}</span>
                    <span>指纹：<code>{maskFingerprint(item.fingerprint)}</code></span>
                    <span>更新时间：{formatDate(item.updatedAt || item.createdAt)}</span>
                  </div>
                  {metadataLabels.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>{metadataLabels.join(' · ')}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  {item.status === 'active' && (
                    <Button variant="secondary" disabled={workingId === item.id} onClick={() => void revoke(item)}>
                      {workingId === item.id ? '处理中…' : '撤销'}
                    </Button>
                  )}
                  <Button variant="ghost" disabled={workingId === item.id} onClick={() => void remove(item)}>删除</Button>
                </div>
              </div>
            </div>
          );
        })
      )}

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
            <Button variant="ghost" disabled={saving} onClick={() => setShowCreate(false)}>取消</Button>
            <Button type="submit" form="credential-vault-create-form" variant="primary" loading={saving} loadingLabel="保存中…">安全保存</Button>
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
            <Input value={name} onChange={(event) => setName(event.target.value)} style={{ width: '100%', marginTop: 6 }} placeholder="例如：主账号 Session" />
          </label>
          <label style={{ fontSize: 13 }}>
            凭证内容
            <TextArea value={secret} onChange={(event) => setSecret(event.target.value)} style={{ width: '100%', marginTop: 6, minHeight: 100, resize: 'vertical' }} placeholder="不会回显到列表或 API 响应" />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <label style={{ fontSize: 13 }}>
              用户名（可选）
              <Input value={username} onChange={(event) => setUsername(event.target.value)} style={{ width: '100%', marginTop: 6 }} />
            </label>
            <label style={{ fontSize: 13 }}>
              Origin（可选）
              <Input value={origin} onChange={(event) => setOrigin(event.target.value)} style={{ width: '100%', marginTop: 6 }} placeholder="https://site.example.com" />
            </label>
          </div>
          <label style={{ fontSize: 13 }}>
            到期时间（可选）
            <Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} style={{ width: '100%', marginTop: 6 }} />
          </label>
        </form>
      </CenteredModal>
      {confirmationDialog}
    </div>
  );
}
