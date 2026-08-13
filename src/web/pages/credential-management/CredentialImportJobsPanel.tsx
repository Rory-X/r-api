import React, { useEffect, useState } from 'react';
import { api, type CredentialImportJob, type CredentialImportTarget } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { useToast } from '../../components/Toast.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { Button, Option, Select } from '../../components/ui/index.js';
import { KIND_LABELS, formatDate, maskFingerprint, type SiteRow } from './shared.js';

type Props = {
  sites: SiteRow[];
  refreshToken: number;
  focusJobId?: string;
};

const STATUS_LABELS: Record<CredentialImportJob['status'], string> = {
  previewed: '已预览',
  running: '执行中',
  completed: '已完成',
  partial: '部分成功',
  failed: '失败',
};

const TARGET_LABELS: Record<CredentialImportTarget, string> = {
  new_api: 'NewAPI / OneAPI',
  sub2api: 'Sub2API',
  native_oauth: '原生 OAuth',
  api_key: '通用 API Key',
  vault: 'Vault',
};

function statusColor(status: CredentialImportJob['status']): string {
  if (status === 'completed') return 'var(--color-success)';
  if (status === 'running') return 'var(--color-primary)';
  if (status === 'partial' || status === 'previewed') return 'var(--color-warning)';
  return 'var(--color-danger)';
}

function summary(job: CredentialImportJob): string {
  return `新增 ${job.imported} · 更新 ${job.updated} · 跳过 ${job.skipped} · 失败 ${job.failed}`;
}

function targetIds(item: NonNullable<CredentialImportJob['items']>[number]): string {
  const values = [
    item.accountId ? `账号 #${item.accountId}` : '',
    ...(item.vaultItemIds || []).map((id) => `Vault #${id}`),
  ].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : '—';
}

export default function CredentialImportJobsPanel({ sites, refreshToken, focusJobId }: Props) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [jobs, setJobs] = useState<CredentialImportJob[]>([]);
  const [siteFilter, setSiteFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<CredentialImportJob | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await api.getCredentialImportJobs({
        limit: 100,
        siteId: siteFilter ? Number(siteFilter) : undefined,
      });
      setJobs(Array.isArray(response.jobs) ? response.jobs : []);
    } catch (error: any) {
      toast.error(error?.message || '加载凭证导入任务失败');
    } finally {
      setLoading(false);
    }
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const response = await api.getCredentialImportJob(id);
      setDetail(response.job);
    } catch (error: any) {
      toast.error(error?.message || '加载导入任务详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [siteFilter, refreshToken]);

  useEffect(() => {
    if (focusJobId) void openDetail(focusJobId);
  }, [focusJobId, refreshToken]);

  return (
    <div className="management-page-stack" style={{ gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <Select value={siteFilter} onChange={(event) => setSiteFilter(event.target.value)} style={{ width: 240 }} aria-label="导入任务站点筛选">
          <Option value="">全部站点</Option>
          {sites.map((site) => <Option key={site.id} value={site.id}>{site.name} · {site.platform}</Option>)}
        </Select>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</Button>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{jobs.length} 个任务</span>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 24 }}><div className="skeleton" style={{ height: 180 }} /></div>
      ) : jobs.length === 0 ? (
        <div className="card" style={{ padding: 28, color: 'var(--color-text-muted)', fontSize: 13 }}>暂无凭证导入任务</div>
      ) : isMobile ? (
        <div className="mobile-card-list">
          {jobs.map((job) => {
            const site = sites.find((item) => item.id === job.siteId);
            return (
              <MobileCard
                key={job.id}
                title={job.target ? TARGET_LABELS[job.target] : '未选择目标'}
                subtitle={job.detection.format}
                footerActions={<Button variant="link" disabled={detailLoading} onClick={() => void openDetail(job.id)}>查看详情</Button>}
              >
                <MobileField label="状态" value={<span style={{ color: statusColor(job.status) }}>{STATUS_LABELS[job.status]}</span>} />
                <MobileField label="站点" value={site?.name || (job.target === 'native_oauth' ? '原生 OAuth' : '—')} />
                <MobileField label="候选" value={`${job.candidateCount} 条，重复 ${job.duplicateCount} 条`} />
                <MobileField label="结果" value={summary(job)} stacked />
                <MobileField label="创建时间" value={formatDate(job.createdAt)} />
              </MobileCard>
            );
          })}
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border-light)', textAlign: 'left' }}>
                <th style={{ padding: 12 }}>来源 / 目标</th>
                <th style={{ padding: 12 }}>状态</th>
                <th style={{ padding: 12 }}>站点</th>
                <th style={{ padding: 12 }}>候选</th>
                <th style={{ padding: 12 }}>执行结果</th>
                <th style={{ padding: 12 }}>创建时间</th>
                <th style={{ padding: 12, width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const site = sites.find((item) => item.id === job.siteId);
                return (
                  <tr key={job.id} style={{ borderBottom: '1px solid var(--color-border-light)' }}>
                    <td style={{ padding: 12, fontSize: 12 }}>
                      <strong style={{ display: 'block', fontSize: 13 }}>{job.detection.format}</strong>
                      <span style={{ display: 'block', marginTop: 4, color: 'var(--color-text-muted)' }}>{job.target ? TARGET_LABELS[job.target] : '未选择目标'}</span>
                    </td>
                    <td style={{ padding: 12 }}><span style={{ color: statusColor(job.status), fontSize: 12, fontWeight: 600 }}>{STATUS_LABELS[job.status]}</span></td>
                    <td style={{ padding: 12, fontSize: 12 }}>{site?.name || (job.target === 'native_oauth' ? '原生 OAuth' : '—')}</td>
                    <td style={{ padding: 12, fontSize: 12 }}>{job.candidateCount} 条<span style={{ display: 'block', marginTop: 4, color: 'var(--color-text-muted)' }}>重复 {job.duplicateCount}</span></td>
                    <td style={{ padding: 12, fontSize: 12 }}>{summary(job)}</td>
                    <td style={{ padding: 12, fontSize: 12 }}>{formatDate(job.createdAt)}</td>
                    <td style={{ padding: 12 }}><Button variant="link" disabled={detailLoading} onClick={() => void openDetail(job.id)}>详情</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <CenteredModal
        open={detail !== null}
        onClose={() => { if (!detailLoading) setDetail(null); }}
        title="导入任务详情"
        maxWidth={820}
        closeOnEscape={!detailLoading}
        bodyStyle={{ maxHeight: 'calc(90vh - 120px)', overflowY: 'auto' }}
        footer={<Button variant="ghost" onClick={() => setDetail(null)}>关闭</Button>}
      >
        {detail && (
          <div className="management-page-stack" style={{ gap: 12 }} data-testid="credential-import-job-detail">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, fontSize: 12 }}>
              <div><span style={{ color: 'var(--color-text-muted)' }}>任务 ID</span><code style={{ display: 'block', marginTop: 4, overflowWrap: 'anywhere' }}>{detail.id}</code></div>
              <div><span style={{ color: 'var(--color-text-muted)' }}>状态</span><strong style={{ display: 'block', marginTop: 4, color: statusColor(detail.status) }}>{STATUS_LABELS[detail.status]}</strong></div>
              <div><span style={{ color: 'var(--color-text-muted)' }}>来源</span><strong style={{ display: 'block', marginTop: 4 }}>{detail.detection.format}</strong></div>
              <div><span style={{ color: 'var(--color-text-muted)' }}>结果</span><strong style={{ display: 'block', marginTop: 4 }}>{summary(detail)}</strong></div>
            </div>
            {detail.failureMessage && <div style={{ color: 'var(--color-danger)', fontSize: 12 }}>{detail.failureMessage}</div>}
            {(detail.items || []).map((item) => {
              const secretKinds = Object.entries(item.secretSummary).filter(([, present]) => present).map(([key]) => key);
              return (
                <div key={item.id} style={{ borderTop: '1px solid var(--color-border-light)', paddingTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>#{item.index + 1} {item.provider || '未指定 Provider'} · {KIND_LABELS[item.kind] || item.kind}</strong>
                    <span style={{ fontSize: 12, color: item.status === 'imported' || item.status === 'updated' ? 'var(--color-success)' : item.status === 'failed' ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>{item.status}</span>
                  </div>
                  <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
                    指纹 <code>{maskFingerprint(item.fingerprint)}</code> · 秘密字段 {secretKinds.length > 0 ? secretKinds.join(' / ') : '无'} · 目标 {targetIds(item)}
                  </div>
                  {item.message && <div style={{ marginTop: 6, fontSize: 12 }}>{item.message}</div>}
                  {item.validation.errors.length > 0 && <div style={{ marginTop: 6, color: 'var(--color-danger)', fontSize: 12 }}>{item.validation.errors.join('；')}</div>}
                  {item.validation.warnings.length > 0 && <div style={{ marginTop: 6, color: 'var(--color-warning)', fontSize: 12 }}>{item.validation.warnings.join('；')}</div>}
                </div>
              );
            })}
          </div>
        )}
      </CenteredModal>
    </div>
  );
}
