import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, type AdminTotpSetupResponse, type AdminTotpStatus } from '../api.js';
import CenteredModal from './CenteredModal.js';
import { useToast } from './Toast.js';
import { Button, TextField } from './ui/index.js';

type TotpModalStep = 'manage' | 'setup' | 'recovery-codes';

type AdminTotpModalProps = {
  open: boolean;
  status: AdminTotpStatus;
  onClose: () => void;
  onStatusChange: (status: AdminTotpStatus) => void;
};

function downloadRecoveryCodes(codes: string[]) {
  const blob = new Blob([
    `Metapi administrator recovery codes\nGenerated: ${new Date().toISOString()}\n\n${codes.join('\n')}\n`,
  ], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'metapi-admin-recovery-codes.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export default function AdminTotpModal({
  open,
  status,
  onClose,
  onStatusChange,
}: AdminTotpModalProps) {
  const toast = useToast();
  const [step, setStep] = useState<TotpModalStep>('manage');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<AdminTotpSetupResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<'setup' | 'confirm' | 'regenerate' | 'disable' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const clearSensitiveState = () => {
      setStep('manage');
      setPassword('');
      setCode('');
      setSetup(null);
      setQrDataUrl('');
      setRecoveryCodes([]);
      setBusyAction(null);
      setError('');
    };
    if (open) {
      clearSensitiveState();
      return;
    }
    const timeout = setTimeout(clearSensitiveState, 220);
    return () => clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!setup?.otpauthUrl) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(setup.otpauthUrl, {
      width: 224,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    }).catch(() => {
      if (!cancelled) setError('二维码生成失败，请使用下方密钥手动添加。');
    });
    return () => {
      cancelled = true;
    };
  }, [setup?.otpauthUrl]);

  const handleBeginSetup = async () => {
    if (!password) {
      setError('请输入管理员登录凭据');
      return;
    }
    setBusyAction('setup');
    setError('');
    try {
      const result = await api.beginAdminTotpSetup(password);
      setSetup(result);
      setPassword('');
      setCode('');
      setStep('setup');
    } catch (err: any) {
      setError(err?.message || '无法开始双重验证设置');
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmSetup = async () => {
    if (!setup || !code.trim()) {
      setError('请输入验证器中的动态验证码');
      return;
    }
    setBusyAction('confirm');
    setError('');
    try {
      const result = await api.confirmAdminTotpSetup(setup.setupToken, code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setQrDataUrl('');
      setCode('');
      setStep('recovery-codes');
      onStatusChange({
        enabled: true,
        enabledAt: new Date().toISOString(),
        recoveryCodesRemaining: result.recoveryCodesRemaining,
      });
      toast.success('双重验证已启用');
    } catch (err: any) {
      setError(err?.message || '动态验证码验证失败');
    } finally {
      setBusyAction(null);
    }
  };

  const validateManageFields = () => {
    if (!password || !code.trim()) {
      setError('请输入管理员登录凭据和动态验证码或恢复码');
      return false;
    }
    return true;
  };

  const handleRegenerateRecoveryCodes = async () => {
    if (!validateManageFields()) return;
    setBusyAction('regenerate');
    setError('');
    try {
      const result = await api.regenerateAdminRecoveryCodes(password, code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setPassword('');
      setCode('');
      setStep('recovery-codes');
      onStatusChange({ ...status, recoveryCodesRemaining: result.recoveryCodesRemaining });
      toast.success('恢复码已重新生成，旧恢复码已全部失效');
    } catch (err: any) {
      setError(err?.message || '恢复码生成失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDisable = async () => {
    if (!validateManageFields()) return;
    setBusyAction('disable');
    setError('');
    try {
      await api.disableAdminTotp(password, code.trim());
      onStatusChange({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0 });
      toast.success('双重验证已停用');
      onClose();
    } catch (err: any) {
      setError(err?.message || '停用双重验证失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopy = async (value: string, successMessage: string) => {
    try {
      await copyText(value);
      toast.success(successMessage);
    } catch {
      toast.error('复制失败');
    }
  };

  const busy = busyAction !== null;
  const title = step === 'recovery-codes'
    ? '保存恢复码'
    : status.enabled
      ? '管理双重验证'
      : '启用双重验证';
  const footer = step === 'recovery-codes' ? (
    <Button variant="primary" onClick={onClose}>已保存，关闭</Button>
  ) : step === 'setup' ? (
    <>
      <Button variant="ghost" disabled={busy} onClick={() => { setStep('manage'); setSetup(null); setCode(''); setError(''); }}>返回</Button>
      <Button
        variant="primary"
        loading={busyAction === 'confirm'}
        loadingLabel="验证中..."
        disabled={busy || !code.trim()}
        onClick={() => void handleConfirmSetup()}
      >
        确认启用
      </Button>
    </>
  ) : status.enabled ? (
    <>
      <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      <Button
        variant="ghost"
        loading={busyAction === 'regenerate'}
        loadingLabel="生成中..."
        disabled={busy || !password || !code.trim()}
        onClick={() => void handleRegenerateRecoveryCodes()}
      >
        重新生成恢复码
      </Button>
      <Button
        variant="danger"
        loading={busyAction === 'disable'}
        loadingLabel="停用中..."
        disabled={busy || !password || !code.trim()}
        onClick={() => void handleDisable()}
      >
        停用双重验证
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      <Button
        variant="primary"
        loading={busyAction === 'setup'}
        loadingLabel="验证中..."
        disabled={busy || !password}
        onClick={() => void handleBeginSetup()}
      >
        继续设置
      </Button>
    </>
  );

  return (
    <CenteredModal
      open={open}
      onClose={() => { if (!busy && step !== 'recovery-codes') onClose(); }}
      title={title}
      maxWidth={560}
      closeOnBackdrop={!busy && step !== 'recovery-codes'}
      closeOnEscape={!busy && step !== 'recovery-codes'}
      showCloseButton={step !== 'recovery-codes'}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={footer}
    >
          {step === 'manage' && !status.enabled && (
            <>
              <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                使用支持 TOTP 的验证器保护 WebUI 管理员登录。启用后，密码登录还需要动态验证码或恢复码。
              </p>
              <TextField
                label="管理员登录凭据"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => { setPassword(event.target.value); setError(''); }}
                onKeyDown={(event) => { if (event.key === 'Enter') void handleBeginSetup(); }}
                placeholder="验证当前登录凭据"
              />
            </>
          )}

          {step === 'setup' && setup && (
            <>
              <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
                用验证器扫描二维码，然后输入生成的 6 位动态验证码完成绑定。
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', minHeight: 224 }}>
                {qrDataUrl
                  ? <img src={qrDataUrl} width={224} height={224} alt="TOTP 设置二维码" style={{ border: '1px solid var(--color-border-light)' }} />
                  : <div className="skeleton" style={{ width: 224, height: 224, borderRadius: 'var(--radius-sm)' }} />}
              </div>
              <div className="ui-field">
                <div className="ui-field-label">手动设置密钥</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                  <code style={{ flex: 1, minWidth: 0, padding: '10px 12px', overflowWrap: 'anywhere', background: 'var(--color-bg)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
                    {setup.secret}
                  </code>
                  <Button variant="ghost" onClick={() => void handleCopy(setup.secret, '设置密钥已复制')}>复制</Button>
                </div>
              </div>
              <TextField
                label="6 位动态验证码"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => { setCode(event.target.value); setError(''); }}
                onKeyDown={(event) => { if (event.key === 'Enter') void handleConfirmSetup(); }}
                placeholder="000000"
              />
            </>
          )}

          {step === 'manage' && status.enabled && (
            <>
              <div className="alert alert-info">
                双重验证已启用，当前剩余 {status.recoveryCodesRemaining} 枚恢复码。
              </div>
              <TextField
                label="管理员登录凭据"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => { setPassword(event.target.value); setError(''); }}
                placeholder="验证当前登录凭据"
              />
              <TextField
                label="动态验证码或恢复码"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => { setCode(event.target.value); setError(''); }}
                placeholder="6 位动态验证码或恢复码"
              />
            </>
          )}

          {step === 'recovery-codes' && (
            <>
              <div className="alert alert-warning">
                这些恢复码只显示一次。每枚只能使用一次，新生成恢复码后旧码会立即失效。
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                {recoveryCodes.map((recoveryCode) => (
                  <code
                    key={recoveryCode}
                    style={{ padding: '9px 10px', textAlign: 'center', background: 'var(--color-bg)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', fontSize: 12, overflowWrap: 'anywhere' }}
                  >
                    {recoveryCode}
                  </code>
                ))}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <Button variant="ghost" onClick={() => void handleCopy(recoveryCodes.join('\n'), '恢复码已复制')}>复制全部</Button>
                <Button variant="ghost" onClick={() => downloadRecoveryCodes(recoveryCodes)}>下载文本</Button>
              </div>
            </>
          )}

          {error && <div className="alert alert-error">{error}</div>}
    </CenteredModal>
  );
}
