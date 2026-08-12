import React, { useEffect, useMemo, useState } from 'react';
import { api, type BrowserRecoveryTask, type SiteAdapterContract } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import { useToast } from '../components/Toast.js';
import { Button, Input, Option, Select } from '../components/ui/index.js';

type SiteRow = { id: number; name: string; platform: string; url?: string };

const STATUS_LABELS: Record<BrowserRecoveryTask['status'], string> = {
  pending: '等待领取',
  claimed: '已领取',
  completing: '写入中',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已过期',
};

const MODE_LABELS: Record<BrowserRecoveryTask['mode'], string> = {
  manual: '手动',
  assisted: '辅助',
  managed: '托管',
};

const TASK_PAGE_SIZE = 8;

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export default function BrowserRecoveryTasks() {
  const toast = useToast();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [accounts, setAccounts] = useState<Array<{ id: number; siteId: number; username?: string | null }>>([]);
  const [contracts, setContracts] = useState<SiteAdapterContract[]>([]);
  const [tasks, setTasks] = useState<BrowserRecoveryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [mode, setMode] = useState<BrowserRecoveryTask['mode']>('assisted');
  const [credentialName, setCredentialName] = useState('');
  const [ttlSec, setTtlSec] = useState(300);
  const [launchUrl, setLaunchUrl] = useState('');
  const [activationAccountIds, setActivationAccountIds] = useState<Record<string, string>>({});
  const [taskPage, setTaskPage] = useState(1);

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
  const contractByPlatform = useMemo(
    () => new Map(contracts.map((contract) => [contract.platformName, contract])),
    [contracts],
  );
  const selectedSite = sites.find((site) => String(site.id) === siteId);
  const selectedContract = selectedSite ? contractByPlatform.get(selectedSite.platform) : undefined;
  const availableModes = (selectedContract?.browser.modes || []) as BrowserRecoveryTask['mode'][];
  const taskTotalPages = Math.max(1, Math.ceil(tasks.length / TASK_PAGE_SIZE));
  const safeTaskPage = Math.min(taskPage, taskTotalPages);
  const visibleTasks = useMemo(
    () => tasks.slice((safeTaskPage - 1) * TASK_PAGE_SIZE, safeTaskPage * TASK_PAGE_SIZE),
    [safeTaskPage, tasks],
  );

  const load = async () => {
    setLoading(true);
    try {
      const [siteRows, contractResponse, taskResponse, accountRows] = await Promise.all([
        api.getSites(),
        api.getSiteAdapterContracts(),
        api.getBrowserRecoveryTasks(),
        api.getAccounts(),
      ]);
      setSites(Array.isArray(siteRows) ? siteRows : []);
      setAccounts(Array.isArray(accountRows) ? accountRows : []);
      setContracts(Array.isArray(contractResponse?.adapters) ? contractResponse.adapters : []);
      setTasks(Array.isArray(taskResponse?.items) ? taskResponse.items : []);
    } catch (error: any) {
      toast.error(error?.message || '加载浏览器凭证任务失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    setTaskPage((current) => Math.min(current, taskTotalPages));
  }, [taskTotalPages]);

  useEffect(() => {
    if (!availableModes.includes(mode)) setMode(availableModes[0] || 'assisted');
    if (selectedContract?.browser.taskTtlSec) setTtlSec(selectedContract.browser.taskTtlSec);
  }, [availableModes, mode, selectedContract]);

  const resetForm = () => {
    setSiteId('');
    setAccountId('');
    setMode('assisted');
    setCredentialName('');
    setTtlSec(300);
  };

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!siteId || !availableModes.includes(mode)) {
      toast.error('请选择支持浏览器凭证采集的站点和模式');
      return;
    }
    setSaving(true);
    try {
      const result = await api.createBrowserRecoveryTask({
        siteId: Number(siteId),
        accountId: accountId ? Number(accountId) : null,
        mode,
        credentialName: credentialName.trim() || undefined,
        ttlSec,
      });
      const absolute = new URL(result.launchPath, window.location.origin).toString();
      setLaunchUrl(absolute);
      setShowCreate(false);
      resetForm();
      toast.success('浏览器凭证任务已创建，令牌只在这次响应中显示');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '创建浏览器凭证任务失败');
    } finally {
      setSaving(false);
    }
  };

  const activate = async (task: BrowserRecoveryTask) => {
    const selected = task.accountId || Number(activationAccountIds[task.id] || 0) || null;
    if (!selected) {
      toast.error('请选择要绑定的账号');
      return;
    }
    setWorkingId(task.id);
    try {
      const result = await api.activateBrowserRecoveryTask(task.id, selected);
      toast.success(result.activation.idempotent ? '凭证已经启用' : '凭证验证通过，已绑定账号并刷新路由');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '启用浏览器凭证失败');
    } finally {
      setWorkingId(null);
    }
  };

  const cancel = async (id: string) => {
    setWorkingId(id);
    try {
      await api.cancelBrowserRecoveryTask(id);
      toast.success('任务已取消');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '取消任务失败');
    } finally {
      setWorkingId(null);
    }
  };

  const copyLaunchUrl = async () => {
    if (!launchUrl) return;
    try {
      await navigator.clipboard.writeText(launchUrl);
      toast.success('凭证采集链接已复制');
    } catch {
      toast.error('当前浏览器不允许复制，请手动选择链接');
    }
  };

  if (loading) {
    return <div className="animate-fade-in"><div className="skeleton" style={{ width: 260, height: 28, marginBottom: 20 }} /><div className="skeleton" style={{ width: '100%', height: 240, borderRadius: 'var(--radius-sm)' }} /></div>;
  }

  return (
    <div className="animate-fade-in" style={{ paddingBottom: 40 }}>
      <div className="page-header">
        <div>
          <h2 className="page-title">浏览器凭证</h2>
          <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
            任务令牌只可领取一次；站点 Origin 和字段由适配器契约锁定。
          </div>
        </div>
        <div className="page-actions">
          <Button className="btn btn-primary" onClick={() => setShowCreate(true)}>创建任务</Button>
        </div>
      </div>

      <div className="management-page-stack" style={{ gap: 12 }}>
        {launchUrl && (
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>新任务凭证采集链接</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input readOnly value={launchUrl} style={{ ...inputStyle, flex: 1, minWidth: 0 }} onFocus={(event) => event.currentTarget.select()} />
              <Button className="btn btn-secondary" onClick={() => void copyLaunchUrl()}>复制</Button>
            </div>
            <div style={{ color: 'var(--color-text-muted)', fontSize: 12, marginTop: 8 }}>原始令牌不会在任务列表中再次出现；链接失效后请重新创建任务。</div>
          </div>
        )}

        {tasks.length === 0 ? (
          <div className="card" style={{ padding: 28, color: 'var(--color-text-muted)', fontSize: 13 }}>暂无浏览器凭证任务</div>
        ) : visibleTasks.map((task) => {
          const site = sites.find((row) => row.id === task.siteId);
          const terminal = ['completed', 'cancelled', 'expired'].includes(task.status);
          return (
            <div key={task.id} className="card" style={{ padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 14 }}>{task.credentialName}</strong>
                    <span style={{ color: task.status === 'completed' ? 'var(--color-success)' : 'var(--color-text-muted)', fontSize: 11 }}>{STATUS_LABELS[task.status]}</span>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{MODE_LABELS[task.mode]}</span>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    <span>站点：{site?.name || task.adapterPlatform}</span>
                    <span>Origin：{task.targetOrigin}</span>
                    <span>到期：{formatDate(task.expiresAt)}</span>
                    {task.resultCredentialId ? <span>凭证 #{task.resultCredentialId}</span> : null}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {task.status === 'completed' && task.resultCredentialId ? (
                    <>
                      {!task.accountId && (
                        <Select
                          value={activationAccountIds[task.id] || ''}
                          onChange={(event) => setActivationAccountIds((current) => ({ ...current, [task.id]: event.target.value }))}
                          style={{ width: 220 }}
                        >
                          <Option value="">选择绑定账号</Option>
                          {accounts.filter((account) => account.siteId === task.siteId).map((account) => (
                            <Option key={account.id} value={account.id}>{account.username || `账号 #${account.id}`}</Option>
                          ))}
                        </Select>
                      )}
                      <Button className="btn btn-primary" disabled={workingId === task.id} onClick={() => void activate(task)}>
                        {workingId === task.id ? '验证中…' : task.accountId ? '启用凭证' : '绑定并启用'}
                      </Button>
                    </>
                  ) : null}
                  {!terminal && (
                    <Button className="btn btn-ghost" disabled={workingId === task.id} onClick={() => void cancel(task.id)}>
                      {workingId === task.id ? '处理中…' : '取消'}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {tasks.length > TASK_PAGE_SIZE && (
          <div className="card" style={{ padding: '12px 16px', display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ marginRight: 'auto', color: 'var(--color-text-muted)', fontSize: 12 }}>
              共 {tasks.length} 个任务 · 第 {safeTaskPage}/{taskTotalPages} 页
            </span>
            <Button type="button" variant="ghost" disabled={safeTaskPage <= 1} onClick={() => setTaskPage((current) => Math.max(1, current - 1))}>
              上一页
            </Button>
            <Button type="button" variant="ghost" disabled={safeTaskPage >= taskTotalPages} onClick={() => setTaskPage((current) => Math.min(taskTotalPages, current + 1))}>
              下一页
            </Button>
          </div>
        )}
      </div>

      <CenteredModal
        open={showCreate}
        onClose={() => { if (!saving) setShowCreate(false); }}
        title="创建浏览器凭证任务"
        maxWidth={560}
        closeOnBackdrop={!saving}
        closeOnEscape={!saving}
        footer={(
          <>
            <Button type="button" variant="ghost" disabled={saving} onClick={() => setShowCreate(false)}>取消</Button>
            <Button type="submit" form="browser-recovery-create-form" variant="primary" loading={saving} loadingLabel="创建中…">
              创建任务
            </Button>
          </>
        )}
      >
          <form id="browser-recovery-create-form" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} onSubmit={submitCreate}>
            <label style={{ fontSize: 13 }}>站点
              <Select value={siteId} onChange={(event) => setSiteId(event.target.value)} style={{ width: '100%', marginTop: 6 }}>
                <Option value="">请选择站点</Option>
                {sites.map((site) => <Option key={site.id} value={site.id}>{site.name} · {site.platform}</Option>)}
              </Select>
            </label>
            <label style={{ fontSize: 13 }}>采集模式
              <Select value={mode} onChange={(event) => setMode(event.target.value as BrowserRecoveryTask['mode'])} style={{ width: '100%', marginTop: 6 }} disabled={!siteId}>
                {!siteId && <Option value="assisted">先选择站点</Option>}
                {availableModes.map((value) => <Option key={value} value={value}>{MODE_LABELS[value]}</Option>)}
              </Select>
            </label>
            <label style={{ fontSize: 13 }}>绑定账号（可选）
              <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} style={{ width: '100%', marginTop: 6 }} disabled={!siteId}>
                <Option value="">先存入 Vault，稍后绑定</Option>
                {accounts.filter((account) => account.siteId === Number(siteId)).map((account) => (
                  <Option key={account.id} value={account.id}>{account.username || `账号 #${account.id}`}</Option>
                ))}
              </Select>
            </label>
            {selectedContract && (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '8px 10px', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)' }}>
                白名单字段：{selectedContract.browser.fields.map((field) => field.name).join('、')} · 最大 TTL {selectedContract.browser.taskTtlSec}s
              </div>
            )}
            <label style={{ fontSize: 13 }}>凭证名称
              <Input value={credentialName} onChange={(event) => setCredentialName(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} placeholder="例如：主账号浏览器会话" />
            </label>
            <label style={{ fontSize: 13 }}>任务 TTL（秒）
              <Input type="number" min={30} max={3600} value={ttlSec} onChange={(event) => setTtlSec(Number(event.target.value))} style={{ ...inputStyle, marginTop: 6 }} />
            </label>
          </form>
      </CenteredModal>
    </div>
  );
}
