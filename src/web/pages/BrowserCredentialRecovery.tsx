import React, { useMemo, useState } from 'react';
import { api, type BrowserRecoveryTask } from '../api.js';
import { Button, Input, TextArea } from '../components/ui/index.js';

type CapturedValue = Record<string, string>;

function parseTaskHash(): { taskId: string; token: string } | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const taskId = params.get('task') || '';
  const token = params.get('token') || '';
  return taskId && token ? { taskId, token } : null;
}

function clearTaskHash() {
  if (typeof window === 'undefined') return;
  window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
}

function statusText(status: BrowserRecoveryTask['status']): string {
  return {
    pending: '等待领取',
    claimed: '已领取',
    completing: '写入中',
    completed: '已完成',
    cancelled: '已取消',
    expired: '已过期',
  }[status];
}

export default function BrowserCredentialRecovery() {
  const handoff = useMemo(() => parseTaskHash(), []);
  const [task, setTask] = useState<BrowserRecoveryTask | null>(null);
  const [claimToken, setClaimToken] = useState('');
  const [values, setValues] = useState<CapturedValue>({});
  const [origin, setOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const claimManually = async () => {
    if (!handoff) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.claimBrowserRecoveryTask(handoff.taskId, handoff.token, 'browser-web');
      setTask(result.task);
      setClaimToken(result.claimToken);
      setOrigin(result.task.targetOrigin);
      clearTaskHash();
    } catch (claimError: any) {
      setError(claimError?.message || '凭证采集链接无效或已失效');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '11px 12px',
    border: '1px solid #d7dce3',
    borderRadius: 6,
    fontSize: 14,
    outline: 'none',
    background: '#fff',
    color: '#18212f',
    boxSizing: 'border-box',
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!task || !claimToken) return;
    setSaving(true);
    setError('');
    try {
      const fields = task.fields
        .map((field) => ({ name: field.name, kind: field.kind, value: values[field.name] || '' }))
        .filter((field) => field.value || task.fields.find((item) => item.name === field.name)?.required);
      const result = await api.completeBrowserRecoveryTask({
        taskId: task.id,
        claimToken,
        origin,
        fields,
        username: username.trim() || undefined,
      });
      setTask(result.task);
      setMessage(result.idempotent ? '凭证已存在，任务结果保持不变。' : '浏览器凭证已加密保存，可以关闭此页面。');
    } catch (submitError: any) {
      setError(submitError?.message || '保存浏览器凭证失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#657184', fontFamily: 'system-ui, sans-serif' }}>正在验证凭证采集链接…</div>;
  }
  if (!handoff) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, background: '#f5f7fa', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ width: 'min(520px, 100%)', background: '#fff', border: '1px solid #e1e5eb', borderRadius: 8, padding: 28 }}>
          <h1 style={{ margin: '0 0 10px', fontSize: 21, color: '#18212f' }}>浏览器凭证</h1>
          <p style={{ margin: 0, color: '#657184', fontSize: 14 }}>凭证采集链接缺少一次性任务令牌。</p>
        </div>
      </div>
    );
  }
  if (!task) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, background: '#f5f7fa', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ width: 'min(520px, 100%)', background: '#fff', border: '1px solid #e1e5eb', borderRadius: 8, padding: 28 }}>
          <h1 style={{ margin: '0 0 10px', fontSize: 21, color: '#18212f' }}>浏览器凭证</h1>
          <p style={{ margin: '0 0 18px', color: '#657184', fontSize: 14, lineHeight: 1.6 }}>
            一次性令牌尚未领取。已安装 Metapi 浏览器扩展时，可在当前标签页打开扩展并领取；否则选择手动填写。
          </p>
          {error && <div style={{ marginBottom: 14, color: '#b42318', fontSize: 13 }}>{error}</div>}
          <Button type="button" disabled={loading} onClick={() => void claimManually()} style={{ border: 0, borderRadius: 6, background: '#1f6feb', color: '#fff', padding: '11px 14px', fontSize: 14, cursor: loading ? 'wait' : 'pointer' }}>
            {loading ? '领取中…' : '手动填写并领取'}
          </Button>
        </div>
      </div>
    );
  }

  const completed = task.status === 'completed';
  return (
    <div style={{ minHeight: '100vh', background: '#f5f7fa', padding: '48px 20px', fontFamily: 'system-ui, sans-serif', color: '#18212f' }}>
      <main style={{ width: 'min(620px, 100%)', margin: '0 auto', background: '#fff', border: '1px solid #e1e5eb', borderRadius: 8, padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, color: '#657184', marginBottom: 6 }}>Metapi · 浏览器凭证</div>
            <h1 style={{ margin: 0, fontSize: 22 }}>保存 {task.credentialName}</h1>
          </div>
          <span style={{ color: completed ? '#18864b' : '#657184', fontSize: 12 }}>{statusText(task.status)}</span>
        </div>
        <div style={{ marginTop: 18, padding: 12, background: '#f7f9fb', borderRadius: 6, fontSize: 13, color: '#526073' }}>
          目标站点：{task.targetOrigin}<br />
          适配器：{task.adapterPlatform} · 模式：{task.mode}
        </div>

        {completed ? (
          <div style={{ marginTop: 20, padding: 14, border: '1px solid #b9e3ca', background: '#f2fbf5', borderRadius: 6, fontSize: 14, color: '#176b3d' }}>
            {message || '凭证已保存。'}
          </div>
        ) : (
          <form onSubmit={submit} style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 15 }}>
            <label style={{ fontSize: 13 }}>Origin
              <Input value={origin} onChange={(event) => setOrigin(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} />
            </label>
            {task.fields.map((field) => (
              <label key={field.name} style={{ fontSize: 13 }}>
                {field.name}{field.required ? ' *' : ''}
                <TextArea
                  value={values[field.name] || ''}
                  onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                  style={{ ...inputStyle, marginTop: 6, minHeight: 76, resize: 'vertical' }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            ))}
            <label style={{ fontSize: 13 }}>账号标识（可选）
              <Input value={username} onChange={(event) => setUsername(event.target.value)} style={{ ...inputStyle, marginTop: 6 }} autoComplete="off" />
            </label>
            {error && <div style={{ color: '#b42318', fontSize: 13 }}>{error}</div>}
            <Button type="submit" disabled={saving} style={{ border: 0, borderRadius: 6, background: '#1f6feb', color: '#fff', padding: '11px 14px', fontSize: 14, cursor: saving ? 'wait' : 'pointer' }}>
              {saving ? '保存中…' : '加密保存凭证'}
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
