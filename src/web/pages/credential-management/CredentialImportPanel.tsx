import React, { useMemo, useState } from 'react';
import {
  api,
  type CredentialConflictPolicy,
  type CredentialImportExecutionResponse,
  type CredentialImportPreviewResponse,
  type CredentialImportTarget,
} from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { Button, FilePicker, Input, Option, Select, TextArea } from '../../components/ui/index.js';
import { KIND_LABELS, formatDate, maskFingerprint, type SiteRow } from './shared.js';

type Props = {
  sites: SiteRow[];
  onImported: (jobId: string) => void;
};

const TARGET_LABELS: Record<CredentialImportTarget, string> = {
  new_api: 'NewAPI / OneAPI 账号',
  sub2api: 'Sub2API 账号',
  native_oauth: '原生 OAuth 账号',
  api_key: '通用 API Key 账号',
  vault: 'Vault 安全存储',
};

const CONFLICT_LABELS: Record<CredentialConflictPolicy, string> = {
  skip: '跳过已有凭证',
  update: '更新已有凭证',
  create_duplicate: '创建独立副本',
};

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `credential-import-${crypto.randomUUID()}`;
  }
  return `credential-import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('请粘贴凭证内容或选择 JSON 文件');
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function compactIdentity(identity: Record<string, string>): string {
  const values = Object.entries(identity)
    .filter(([, value]) => typeof value === 'string' && Boolean(value.trim()))
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${value}`);
  return values.length > 0 ? values.join(' · ') : '未提供身份字段';
}

function resultSummary(result: CredentialImportExecutionResponse): string {
  return `新增 ${result.imported}，更新 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`;
}

export default function CredentialImportPanel({ sites, onImported }: Props) {
  const toast = useToast();
  const [rawInput, setRawInput] = useState('');
  const [target, setTarget] = useState<CredentialImportTarget>('new_api');
  const [siteId, setSiteId] = useState('');
  const [conflictPolicy, setConflictPolicy] = useState<CredentialConflictPolicy>('skip');
  const [passphrase, setPassphrase] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [preview, setPreview] = useState<CredentialImportPreviewResponse | null>(null);
  const [result, setResult] = useState<CredentialImportExecutionResponse | null>(null);
  const [working, setWorking] = useState<'preview' | 'import' | null>(null);

  const selectedSite = sites.find((site) => String(site.id) === siteId);
  const needsSite = target !== 'native_oauth';
  const readyCount = useMemo(
    () => preview?.candidates.filter((item) => item.validation.status === 'ready' && item.duplicateOfIndex === undefined).length || 0,
    [preview],
  );

  const invalidatePreview = () => {
    setPreview(null);
    setResult(null);
    setIdempotencyKey(createIdempotencyKey());
  };

  const updateInput = (value: string) => {
    setRawInput(value);
    invalidatePreview();
  };

  const updateTarget = (value: CredentialImportTarget) => {
    setTarget(value);
    if (value === 'native_oauth') setSiteId('');
    invalidatePreview();
  };

  const updateSite = (value: string) => {
    setSiteId(value);
    invalidatePreview();
  };

  const updateConflictPolicy = (value: CredentialConflictPolicy) => {
    setConflictPolicy(value);
    invalidatePreview();
  };

  const updatePassphrase = (value: string) => {
    setPassphrase(value);
    invalidatePreview();
  };

  const onFilesChange = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error('凭证文件不能超过 2MB');
      return;
    }
    try {
      updateInput(await file.text());
    } catch (error: any) {
      toast.error(error?.message || '读取凭证文件失败');
    }
  };

  const validateForm = (): unknown | null => {
    if (needsSite && !siteId) {
      toast.error('该导入目标必须选择站点');
      return null;
    }
    try {
      return parseInput(rawInput);
    } catch (error: any) {
      toast.error(error?.message || '凭证输入无效');
      return null;
    }
  };

  const runPreview = async () => {
    const input = validateForm();
    if (input === null) return;
    setWorking('preview');
    setResult(null);
    try {
      const response = await api.previewCredentialImport({
        input,
        target,
        siteId: siteId ? Number(siteId) : undefined,
        conflictPolicy,
        idempotencyKey,
        passphrase: passphrase || undefined,
      });
      setPreview(response);
      if (response.deduplicated) toast.info('已复用相同幂等请求的预览任务');
      else toast.success(`识别完成，共 ${response.candidates.length} 条候选`);
    } catch (error: any) {
      setPreview(null);
      toast.error(error?.message || '凭证预览失败');
    } finally {
      setWorking(null);
    }
  };

  const runImport = async () => {
    if (!preview) {
      toast.error('请先完成预览');
      return;
    }
    const input = validateForm();
    if (input === null) return;
    setWorking('import');
    try {
      const response = await api.executeCredentialImport({
        importJobId: preview.importJobId,
        input,
        target,
        siteId: siteId ? Number(siteId) : undefined,
        batchFingerprint: preview.batchFingerprint,
        conflictPolicy,
        passphrase: passphrase || undefined,
      });
      setResult(response);
      if (response.failed > 0) toast.error(`导入已完成，但有失败项：${resultSummary(response)}`);
      else {
        setRawInput('');
        setPassphrase('');
        setPreview(null);
        setIdempotencyKey(createIdempotencyKey());
        toast.success(`导入完成：${resultSummary(response)}`);
      }
      onImported(response.importJobId);
    } catch (error: any) {
      toast.error(error?.message || '执行凭证导入失败');
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="management-page-stack" style={{ gap: 16 }}>
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <label style={{ fontSize: 13 }}>
            导入目标
            <Select value={target} onChange={(event) => updateTarget(event.target.value as CredentialImportTarget)} style={{ width: '100%', marginTop: 6 }} aria-label="导入目标">
              {Object.entries(TARGET_LABELS).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
            </Select>
          </label>
          <label style={{ fontSize: 13 }}>
            目标站点{needsSite ? '' : '（可选）'}
            <Select value={siteId} onChange={(event) => updateSite(event.target.value)} style={{ width: '100%', marginTop: 6 }} disabled={!needsSite} aria-label="导入目标站点">
              <Option value="">{needsSite ? '请选择站点' : '原生 OAuth 不绑定站点'}</Option>
              {sites.map((site) => <Option key={site.id} value={site.id}>{site.name} · {site.platform}</Option>)}
            </Select>
          </label>
          <label style={{ fontSize: 13 }}>
            冲突策略
            <Select value={conflictPolicy} onChange={(event) => updateConflictPolicy(event.target.value as CredentialConflictPolicy)} style={{ width: '100%', marginTop: 6 }} aria-label="凭证冲突策略">
              {Object.entries(CONFLICT_LABELS).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
            </Select>
          </label>
        </div>

        <label style={{ display: 'block', marginTop: 14, fontSize: 13 }}>
          加密备份口令（仅导入 r-api 加密备份时填写）
          <Input type="password" value={passphrase} onChange={(event) => updatePassphrase(event.target.value)} style={{ width: '100%', marginTop: 6 }} autoComplete="off" />
        </label>

        <div style={{ marginTop: 14 }}>
          <FilePicker
            accept=".json,application/json,text/plain"
            onFilesChange={(files) => { void onFilesChange(files); }}
            buttonLabel="选择凭证文件"
            emptyLabel="支持 JSON、Cockpit transfer、Sub2API bundle 和纯文本 API Key"
            disabled={working !== null}
          />
        </div>

        <label style={{ display: 'block', marginTop: 14, fontSize: 13 }}>
          凭证内容
          <TextArea
            value={rawInput}
            onChange={(event) => updateInput(event.target.value)}
            aria-label="凭证内容"
            style={{ width: '100%', marginTop: 6, minHeight: 220, resize: 'vertical', fontFamily: 'var(--font-mono)' }}
            placeholder="粘贴 JSON、Cockpit account-transfer、Sub2API bundle、原生 OAuth JSON 或 API Key"
            spellCheck={false}
          />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button variant="secondary" loading={working === 'preview'} loadingLabel="识别中…" disabled={working === 'import'} onClick={() => void runPreview()}>预览并校验</Button>
          <Button variant="primary" loading={working === 'import'} loadingLabel="导入中…" disabled={!preview || working === 'preview' || preview.status !== 'previewed'} onClick={() => void runImport()}>执行导入</Button>
        </div>
      </div>

      {preview && (
        <div className="management-page-stack" style={{ gap: 12 }} data-testid="credential-import-preview">
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <strong style={{ fontSize: 14 }}>预览结果</strong>
                <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
                  {preview.detection.format}{preview.detection.version !== undefined ? ` v${preview.detection.version}` : ''}
                  {preview.detection.provider ? ` · ${preview.detection.provider}` : ''}
                  {selectedSite ? ` · ${selectedSite.name}` : ''}
                </div>
              </div>
              <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
                可执行 {readyCount} / {preview.candidates.length} · 批内重复 {preview.duplicateCount}
              </div>
            </div>
            {(preview.warnings.length > 0 || preview.detection.warnings.length > 0) && (
              <div style={{ marginTop: 10, color: 'var(--color-warning)', fontSize: 12 }}>
                {[...new Set([...preview.warnings, ...preview.detection.warnings])].join('；')}
              </div>
            )}
          </div>

          {preview.candidates.map((item, index) => {
            const expiresAt = item.candidate.expiresAt
              ? new Date(item.candidate.expiresAt).toISOString()
              : undefined;
            const secretKinds = Object.entries(item.candidate.secretSummary)
              .filter(([, present]) => present)
              .map(([name]) => name);
            return (
              <div key={`${item.candidate.fingerprint}:${index}`} className="card" style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 13 }}>#{index + 1} {item.candidate.provider || '未指定 Provider'} · {KIND_LABELS[item.candidate.kind] || item.candidate.kind}</strong>
                    <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12, overflowWrap: 'anywhere' }}>{compactIdentity(item.candidate.identity)}</div>
                    <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
                      指纹 <code>{maskFingerprint(item.candidate.fingerprint)}</code> · 秘密字段 {secretKinds.length > 0 ? secretKinds.join(' / ') : '无'} · 到期 {formatDate(expiresAt)}
                    </div>
                  </div>
                  <span style={{ color: item.validation.status === 'ready' ? 'var(--color-success)' : 'var(--color-danger)', fontSize: 12, fontWeight: 600 }}>
                    {item.duplicateOfIndex !== undefined ? `批内重复 #${item.duplicateOfIndex + 1}` : item.validation.status}
                  </span>
                </div>
                {item.validation.errors.length > 0 && <div style={{ marginTop: 8, color: 'var(--color-danger)', fontSize: 12 }}>{item.validation.errors.join('；')}</div>}
                {item.validation.warnings.length > 0 && <div style={{ marginTop: 8, color: 'var(--color-warning)', fontSize: 12 }}>{item.validation.warnings.join('；')}</div>}
              </div>
            );
          })}
        </div>
      )}

      {result && (
        <div className="card" style={{ padding: 16 }} data-testid="credential-import-result">
          <strong style={{ fontSize: 14 }}>任务已完成</strong>
          <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
            {resultSummary(result)} · 任务 <code>{result.importJobId}</code>
          </div>
        </div>
      )}
    </div>
  );
}
