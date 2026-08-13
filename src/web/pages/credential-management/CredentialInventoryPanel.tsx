import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type CredentialExportMode,
  type CredentialLifecycleAction,
  type CredentialLifecycleEntityType,
  type CredentialLifecycleItem,
  type CredentialLifecycleStatus,
} from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import ResponsiveBatchActionBar from '../../components/ResponsiveBatchActionBar.js';
import ResponsiveFilterPanel from '../../components/ResponsiveFilterPanel.js';
import { useToast } from '../../components/Toast.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { Button, Checkbox, Input, Option, Select, useConfirmDialog } from '../../components/ui/index.js';
import {
  ENTITY_LABELS,
  KIND_LABELS,
  LIFECYCLE_STATUS_LABELS,
  downloadJson,
  exportFilename,
  formatDate,
  lifecycleKey,
  lifecycleStatusColor,
  maskFingerprint,
  type SiteRow,
} from './shared.js';

type Props = {
  sites: SiteRow[];
  refreshToken: number;
  onChanged: () => void;
};

const ACTION_LABELS: Record<CredentialLifecycleAction, string> = {
  validate: '验证',
  refresh: '刷新',
  enable: '启用',
  disable: '停用',
  revoke: '撤销',
};

function lifecycleTarget(item: CredentialLifecycleItem) {
  return { entityType: item.entityType, entityId: item.entityId };
}

function refreshOwnerLabel(item: CredentialLifecycleItem): string {
  if (item.refreshOwner === 'r_api') return 'r-api';
  if (item.refreshOwner === 'external') return '外部';
  return '无';
}

function refreshTimestamp(item: CredentialLifecycleItem): string | undefined {
  return item.lastRefreshSuccessAt || item.lastRefreshAttemptAt;
}

export default function CredentialInventoryPanel({ sites, refreshToken, onChanged }: Props) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const { requestConfirmation, confirmationDialog } = useConfirmDialog();
  const [items, setItems] = useState<CredentialLifecycleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [siteFilter, setSiteFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<CredentialLifecycleStatus | ''>('');
  const [entityFilter, setEntityFilter] = useState<CredentialLifecycleEntityType | ''>('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMode, setExportMode] = useState<CredentialExportMode>('metadata_only');
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportExpiresInSec, setExportExpiresInSec] = useState('86400');
  const [portableConfirmed, setPortableConfirmed] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const response = await api.getCredentialLifecycle({
        siteId: siteFilter ? Number(siteFilter) : undefined,
        status: statusFilter || undefined,
        entityType: entityFilter || undefined,
      });
      const next = Array.isArray(response.items) ? response.items : [];
      setItems(next);
      setSelectedKeys((current) => current.filter((key) => next.some((item) => lifecycleKey(item) === key)));
    } catch (error: any) {
      toast.error(error?.message || '加载统一凭证列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [siteFilter, statusFilter, entityFilter, refreshToken]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedKeys.includes(lifecycleKey(item))),
    [items, selectedKeys],
  );
  const allSelected = items.length > 0 && items.every((item) => selectedKeys.includes(lifecycleKey(item)));

  const setSelected = (item: CredentialLifecycleItem, checked: boolean) => {
    const key = lifecycleKey(item);
    setSelectedKeys((current) => checked
      ? [...new Set([...current, key])]
      : current.filter((value) => value !== key));
  };

  const executeAction = async (action: CredentialLifecycleAction, targets: CredentialLifecycleItem[]) => {
    if (targets.length === 0) return;
    if (action === 'revoke') {
      const confirmed = await requestConfirmation({
        title: '撤销凭证',
        description: `将本地撤销 ${targets.length} 条凭证。账号凭证会清除托管秘密并退出路由，Vault 凭证会进入已撤销状态。`,
        confirmLabel: '确认撤销',
        confirmVariant: 'danger',
      });
      if (!confirmed) return;
    }
    setWorking(true);
    try {
      const result = await api.runCredentialLifecycleAction({
        action,
        items: targets.map(lifecycleTarget),
      });
      if (result.failed > 0) {
        const firstFailure = result.items.find((item) => !item.success)?.message;
        toast.error(`${ACTION_LABELS[action]}完成：成功 ${result.succeeded}，失败 ${result.failed}${firstFailure ? `；${firstFailure}` : ''}`);
      } else {
        toast.success(`${ACTION_LABELS[action]}完成，共 ${result.succeeded} 条`);
      }
      setSelectedKeys([]);
      await load();
      onChanged();
    } catch (error: any) {
      toast.error(error?.message || `${ACTION_LABELS[action]}失败`);
    } finally {
      setWorking(false);
    }
  };

  const openExport = () => {
    if (selectedItems.length === 0) {
      toast.error('请先选择要导出的凭证');
      return;
    }
    setExportMode('metadata_only');
    setExportPassphrase('');
    setPortableConfirmed(false);
    setExportOpen(true);
  };

  const runExport = async () => {
    if (exportMode === 'encrypted_backup' && exportPassphrase.length < 12) {
      toast.error('加密备份口令至少需要 12 个字符');
      return;
    }
    if (exportMode === 'portable_secret' && !portableConfirmed) {
      toast.error('请确认这是包含明文秘密的一次性迁移文件');
      return;
    }
    setWorking(true);
    try {
      const accountIds = selectedItems.filter((item) => item.entityType === 'account').map((item) => item.entityId);
      const vaultItemIds = selectedItems.filter((item) => item.entityType === 'vault_item').map((item) => item.entityId);
      const response = await api.exportCredentials({
        mode: exportMode,
        accountIds,
        vaultItemIds,
        ...(exportMode === 'encrypted_backup'
          ? {
            passphrase: exportPassphrase,
            expiresInSec: Number(exportExpiresInSec) || undefined,
          }
          : {}),
        ...(exportMode === 'portable_secret' ? { confirmation: 'EXPORT_SECRETS' } : {}),
      });
      downloadJson(response.export, exportFilename(exportMode));
      toast.success('凭证导出完成');
      setExportPassphrase('');
      setPortableConfirmed(false);
      setExportOpen(false);
    } catch (error: any) {
      toast.error(error?.message || '凭证导出失败');
    } finally {
      setWorking(false);
    }
  };

  const filterControls = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <Select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)} style={{ width: 240 }} aria-label="站点筛选">
        <Option value="">全部站点</Option>
        {sites.map((site) => <Option key={site.id} value={site.id}>{site.name} · {site.platform}</Option>)}
      </Select>
      <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CredentialLifecycleStatus | '')} style={{ width: 170 }} aria-label="生命周期筛选">
        <Option value="">全部状态</Option>
        {Object.entries(LIFECYCLE_STATUS_LABELS).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
      </Select>
      <Select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as CredentialLifecycleEntityType | '')} style={{ width: 150 }} aria-label="凭证归属筛选">
        <Option value="">全部归属</Option>
        <Option value="account">连接账号</Option>
        <Option value="vault_item">Vault</Option>
      </Select>
      <Button variant="ghost" onClick={() => void load()} disabled={loading} aria-label="刷新凭证列表" title="刷新凭证列表">
        {loading ? '刷新中…' : '刷新'}
      </Button>
      <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{items.length} 条</span>
    </div>
  );

  return (
    <div className="management-page-stack" style={{ gap: 12 }}>
      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={mobileFiltersOpen}
        onMobileOpen={() => setMobileFiltersOpen(true)}
        onMobileClose={() => setMobileFiltersOpen(false)}
        mobileTitle="凭证筛选"
        mobileContent={<div style={{ display: 'grid', gap: 12 }}>{filterControls}</div>}
        desktopContent={filterControls}
      />

      {selectedItems.length > 0 && (
        <ResponsiveBatchActionBar isMobile={isMobile} info={`已选 ${selectedItems.length} 项`} desktopStyle={{ marginBottom: 0 }}>
          <Button variant="ghost" disabled={working} onClick={() => void executeAction('validate', selectedItems)}>验证</Button>
          <Button variant="ghost" disabled={working || !selectedItems.some((item) => item.actions.refresh)} onClick={() => void executeAction('refresh', selectedItems.filter((item) => item.actions.refresh))}>刷新</Button>
          <Button variant="ghost" disabled={working} onClick={() => void executeAction('enable', selectedItems.filter((item) => item.actions.enable))}>启用</Button>
          <Button variant="ghost" disabled={working} onClick={() => void executeAction('disable', selectedItems.filter((item) => item.actions.disable))}>停用</Button>
          <Button variant="secondary" disabled={working} onClick={openExport}>导出</Button>
          <Button variant="danger" disabled={working} onClick={() => void executeAction('revoke', selectedItems.filter((item) => item.actions.revoke))}>撤销</Button>
        </ResponsiveBatchActionBar>
      )}

      {loading ? (
        <div className="card" style={{ padding: 24 }}><div className="skeleton" style={{ height: 160 }} /></div>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: 28, color: 'var(--color-text-muted)', fontSize: 13 }}>没有符合筛选条件的凭证</div>
      ) : isMobile ? (
        <div className="mobile-card-list">
          {items.map((item) => (
            <MobileCard
              key={lifecycleKey(item)}
              title={item.name}
              subtitle={`${ENTITY_LABELS[item.entityType]} · ${KIND_LABELS[item.kind] || item.kind}`}
              headerActions={(
                <Checkbox
                  aria-label={`选择凭证 ${item.name}`}
                  checked={selectedKeys.includes(lifecycleKey(item))}
                  onChange={(checked) => setSelected(item, checked)}
                  label={<span className="ui-visually-hidden">选择凭证 {item.name}</span>}
                />
              )}
              footerActions={(
                <>
                  {item.actions.validate && <Button variant="link" disabled={working} onClick={() => void executeAction('validate', [item])}>验证</Button>}
                  {item.actions.refresh && <Button variant="link" disabled={working} onClick={() => void executeAction('refresh', [item])}>刷新</Button>}
                  {item.actions.enable && <Button variant="link" disabled={working} onClick={() => void executeAction('enable', [item])}>启用</Button>}
                  {item.actions.disable && <Button variant="link" disabled={working} onClick={() => void executeAction('disable', [item])}>停用</Button>}
                  {item.actions.revoke && <Button variant="link" className="btn-link-danger" disabled={working} onClick={() => void executeAction('revoke', [item])}>撤销</Button>}
                </>
              )}
            >
              <MobileField label="状态" value={<span style={{ color: lifecycleStatusColor(item.status) }}>{LIFECYCLE_STATUS_LABELS[item.status]}</span>} />
              <MobileField label="站点" value={item.site ? `${item.site.name} · ${item.site.platform}` : '系统'} />
              <MobileField label="刷新归属" value={refreshOwnerLabel(item)} />
              <MobileField label="最近刷新" value={formatDate(refreshTimestamp(item))} />
              <MobileField label="到期时间" value={formatDate(item.expiresAt)} />
              <MobileField
                label="导入来源"
                value={item.provenance
                  ? `${item.provenance.sourceFormat} · ${item.provenance.importAction}`
                  : '非统一导入'}
                stacked
              />
              <MobileField label="状态说明" value={item.statusReason} stacked />
            </MobileCard>
          ))}
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1040 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border-light)', textAlign: 'left' }}>
                <th style={{ padding: 12, width: 42 }}>
                  <Checkbox
                    aria-label="选择全部凭证"
                    checked={allSelected}
                    onChange={(checked) => setSelectedKeys(checked ? items.map(lifecycleKey) : [])}
                    label={<span className="ui-visually-hidden">选择全部凭证</span>}
                  />
                </th>
                <th style={{ padding: 12 }}>凭证</th>
                <th style={{ padding: 12 }}>状态</th>
                <th style={{ padding: 12 }}>站点 / Provider</th>
                <th style={{ padding: 12 }}>刷新 / 来源</th>
                <th style={{ padding: 12 }}>到期 / 最近刷新</th>
                <th style={{ padding: 12, width: 260 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={lifecycleKey(item)} style={{ borderBottom: '1px solid var(--color-border-light)' }}>
                  <td style={{ padding: 12 }}>
                    <Checkbox
                      aria-label={`选择凭证 ${item.name}`}
                      checked={selectedKeys.includes(lifecycleKey(item))}
                      onChange={(checked) => setSelected(item, checked)}
                      label={<span className="ui-visually-hidden">选择凭证 {item.name}</span>}
                    />
                  </td>
                  <td style={{ padding: 12 }}>
                    <strong style={{ display: 'block', fontSize: 13 }}>{item.name}</strong>
                    <span style={{ display: 'block', marginTop: 4, color: 'var(--color-text-muted)', fontSize: 11 }}>
                      {ENTITY_LABELS[item.entityType]} · {KIND_LABELS[item.kind] || item.kind}
                      {item.fingerprint ? ` · ${maskFingerprint(item.fingerprint)}` : ''}
                    </span>
                  </td>
                  <td style={{ padding: 12 }}>
                    <span style={{ color: lifecycleStatusColor(item.status), fontSize: 12, fontWeight: 600 }}>{LIFECYCLE_STATUS_LABELS[item.status]}</span>
                    <span style={{ display: 'block', marginTop: 4, color: 'var(--color-text-muted)', fontSize: 11, maxWidth: 220 }}>{item.statusReason}</span>
                  </td>
                  <td style={{ padding: 12, fontSize: 12 }}>
                    {item.site ? item.site.name : '系统'}
                    <span style={{ display: 'block', marginTop: 4, color: 'var(--color-text-muted)' }}>{item.provider || item.site?.platform || '—'}</span>
                  </td>
                  <td style={{ padding: 12, fontSize: 12 }}>
                    {refreshOwnerLabel(item)}
                    <span style={{ display: 'block', marginTop: 4, color: 'var(--color-text-muted)', maxWidth: 180, overflowWrap: 'anywhere' }}>
                      {item.provenance
                        ? `${item.provenance.sourceFormat} · ${item.provenance.importAction}`
                        : '非统一导入'}
                    </span>
                  </td>
                  <td style={{ padding: 12, fontSize: 12 }}>
                    {formatDate(item.expiresAt)}
                    <span style={{ display: 'block', marginTop: 4, color: 'var(--color-text-muted)' }}>
                      最近刷新 {formatDate(refreshTimestamp(item))}
                    </span>
                  </td>
                  <td style={{ padding: 12 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {item.actions.validate && <Button variant="link" disabled={working} onClick={() => void executeAction('validate', [item])}>验证</Button>}
                      {item.actions.refresh && <Button variant="link" disabled={working} onClick={() => void executeAction('refresh', [item])}>刷新</Button>}
                      {item.actions.enable && <Button variant="link" disabled={working} onClick={() => void executeAction('enable', [item])}>启用</Button>}
                      {item.actions.disable && <Button variant="link" disabled={working} onClick={() => void executeAction('disable', [item])}>停用</Button>}
                      {item.actions.revoke && <Button variant="link" className="btn-link-danger" disabled={working} onClick={() => void executeAction('revoke', [item])}>撤销</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CenteredModal
        open={exportOpen}
        onClose={() => { if (!working) setExportOpen(false); }}
        title="导出所选凭证"
        maxWidth={560}
        closeOnEscape={!working}
        footer={(
          <>
            <Button variant="ghost" disabled={working} onClick={() => setExportOpen(false)}>取消</Button>
            <Button variant="primary" loading={working} loadingLabel="导出中…" onClick={() => void runExport()}>下载 JSON</Button>
          </>
        )}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <label style={{ fontSize: 13 }}>
            导出模式
            <Select value={exportMode} onChange={(event) => setExportMode(event.target.value as CredentialExportMode)} style={{ width: '100%', marginTop: 6 }} aria-label="凭证导出模式">
              <Option value="metadata_only">元数据，不含秘密</Option>
              <Option value="encrypted_backup">口令加密备份</Option>
              <Option value="portable_secret">明文迁移文件</Option>
            </Select>
          </label>
          {exportMode === 'encrypted_backup' && (
            <>
              <label style={{ fontSize: 13 }}>
                备份口令
                <Input type="password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} style={{ width: '100%', marginTop: 6 }} autoComplete="new-password" />
              </label>
              <label style={{ fontSize: 13 }}>
                有效期（秒，可选）
                <Input type="number" min={60} value={exportExpiresInSec} onChange={(event) => setExportExpiresInSec(event.target.value)} style={{ width: '100%', marginTop: 6 }} />
              </label>
            </>
          )}
          {exportMode === 'portable_secret' && (
            <Checkbox
              checked={portableConfirmed}
              onChange={setPortableConfirmed}
              label="我确认该文件包含明文凭证"
              description="仅用于受控迁移，下载后请立即转移并删除本地副本。"
            />
          )}
          <div style={{ padding: 10, border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-muted)', fontSize: 12 }}>
            将导出 {selectedItems.length} 条凭证。所有导出操作都会写入审计事件。
          </div>
        </div>
      </CenteredModal>
      {confirmationDialog}
    </div>
  );
}
