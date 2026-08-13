import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Button from '../web/components/ui/Button.js';
import { TextAreaField, TextField } from '../web/components/ui/FormControls.js';
import {
  originPermissionPattern,
  parseRecoveryLaunchUrl,
  type BrowserRecoveryTask,
} from './protocol.js';
import './popup.css';

declare const chrome: any;

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
const syncTheme = () => {
  document.documentElement.dataset.theme = colorScheme.matches ? 'dark' : 'light';
};
syncTheme();
colorScheme.addEventListener('change', syncTheme);

type ExtensionState = {
  active: boolean;
  serverUrl?: string;
  task?: BrowserRecoveryTask;
  targetTabId?: number | null;
};

type StatusState = {
  message: string;
  kind: 'info' | 'success' | 'error';
};

async function send(message: Record<string, unknown>): Promise<any> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展操作失败');
  return response;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !Number.isInteger(tab.id)) throw new Error('无法读取当前标签页');
  return tab;
}

async function requestPermissions(origins: string[], permissions: string[] = []) {
  const granted = await chrome.permissions.request({ origins, permissions });
  if (!granted) throw new Error('用户未授予本次恢复所需权限');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PopupApp() {
  const [state, setState] = useState<ExtensionState>({ active: false });
  const [taskUrl, setTaskUrl] = useState('');
  const [username, setUsername] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [captureOrigin, setCaptureOrigin] = useState('');
  const [status, setStatus] = useState<StatusState>({ message: '', kind: 'info' });
  const [busyAction, setBusyAction] = useState<'load' | 'claim' | 'open' | 'capture' | 'submit' | 'reset' | null>('load');

  const showStatus = (message: string, kind: StatusState['kind'] = 'info') => {
    setStatus({ message, kind });
  };

  const applyState = (next: ExtensionState, nextValues?: Record<string, string>) => {
    setState(next);
    if (!next.active) {
      setValues({});
      setUsername('');
    } else if (nextValues) {
      setValues(nextValues);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void send({ type: 'metapi.recovery.state' }).then((response) => {
      if (!cancelled) applyState(response);
    }).catch((error) => {
      if (!cancelled) showStatus(errorMessage(error), 'error');
    }).finally(() => {
      if (!cancelled) setBusyAction(null);
    });
    return () => { cancelled = true; };
  }, []);

  const importTask = async () => {
    setBusyAction('claim');
    showStatus('');
    try {
      const tab = await activeTab();
      const launchUrl = taskUrl.trim() || String(tab.url || '');
      const launch = parseRecoveryLaunchUrl(launchUrl);
      await requestPermissions([originPermissionPattern(launch.serverUrl)]);
      const response = await send({ type: 'metapi.recovery.claim', launchUrl });
      applyState(response);
      showStatus('任务已领取。打开目标站点并完成登录后再采集。', 'success');
    } catch (error) {
      showStatus(errorMessage(error), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const openTarget = async () => {
    setBusyAction('open');
    showStatus('');
    try {
      applyState(await send({ type: 'metapi.recovery.open-target' }));
    } catch (error) {
      showStatus(errorMessage(error), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const captureFields = async () => {
    if (!state.task) return;
    setBusyAction('capture');
    showStatus('');
    try {
      const tab = await activeTab();
      const permissions = state.task.fields.some((field) => field.kind === 'cookie') ? ['cookies'] : [];
      await requestPermissions([originPermissionPattern(state.task.targetOrigin)], permissions);
      const response = await send({ type: 'metapi.recovery.capture', tabId: tab.id });
      setCaptureOrigin(response.origin);
      applyState(response, response.values || {});
      showStatus('已读取适配器声明的字段，请确认后提交。', 'success');
    } catch (error) {
      showStatus(errorMessage(error), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const submitTask = async () => {
    if (!state.task) return;
    setBusyAction('submit');
    showStatus('');
    try {
      const response = await send({
        type: 'metapi.recovery.complete',
        origin: captureOrigin || state.task.targetOrigin,
        values,
        username,
      });
      applyState({ active: false });
      setTaskUrl('');
      setCaptureOrigin('');
      showStatus(response.idempotent ? '任务此前已完成。' : '凭证已加密写入 r-api Vault。', 'success');
    } catch (error) {
      showStatus(errorMessage(error), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const resetTask = async () => {
    setBusyAction('reset');
    showStatus('');
    try {
      await send({ type: 'metapi.recovery.reset' });
      applyState({ active: false });
      setCaptureOrigin('');
      showStatus('本地任务状态已清除。');
    } catch (error) {
      showStatus(errorMessage(error), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const busy = busyAction !== null;

  return (
    <main className="extension-popup">
      <header className="extension-header">
        <strong>r-api 浏览器凭证</strong>
        <span>仅采集站点适配器声明字段</span>
      </header>

      {!state.active || !state.task ? (
        <section className="extension-section">
          <TextAreaField
            label="凭证采集链接"
            value={taskUrl}
            onChange={(event) => setTaskUrl(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="打开任务链接后可留空，扩展会读取当前标签页"
          />
          <Button
            variant="primary"
            loading={busyAction === 'claim' || busyAction === 'load'}
            loadingLabel={busyAction === 'load' ? '读取中...' : '领取中...'}
            disabled={busy}
            onClick={() => void importTask()}
          >
            领取当前任务
          </Button>
        </section>
      ) : (
        <section className="extension-section">
          <div className="task-summary">
            <strong>{state.task.credentialName}</strong>
            <span>{state.task.adapterPlatform} · {state.task.targetOrigin} · {state.task.mode}</span>
          </div>

          <div className="extension-actions">
            <Button
              variant="secondary"
              loading={busyAction === 'open'}
              disabled={busy}
              onClick={() => void openTarget()}
            >
              打开目标站点
            </Button>
            <Button
              variant="primary"
              loading={busyAction === 'capture'}
              disabled={busy}
              onClick={() => void captureFields()}
            >
              采集声明字段
            </Button>
          </div>

          <div className="extension-field-list">
            {state.task.fields.map((field) => (
              <TextAreaField
                key={field.name}
                label={field.name}
                required={field.required}
                value={values[field.name] || ''}
                onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                rows={2}
                spellCheck={false}
                autoComplete="off"
                placeholder={field.capture?.strategy === 'manual' ? '手动填写' : '尚未采集'}
              />
            ))}
          </div>

          <TextField
            label="账号标识（可选）"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
          />

          <div className="extension-actions">
            <Button
              variant="secondary"
              loading={busyAction === 'reset'}
              disabled={busy}
              onClick={() => void resetTask()}
            >
              清除本地状态
            </Button>
            <Button
              variant="primary"
              loading={busyAction === 'submit'}
              loadingLabel="保存中..."
              disabled={busy}
              onClick={() => void submitTask()}
            >
              加密保存
            </Button>
          </div>
        </section>
      )}

      {status.message ? (
        <div className="extension-status" data-kind={status.kind} role="status">
          {status.message}
        </div>
      ) : null}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('扩展挂载节点不存在');
createRoot(root).render(<PopupApp />);
