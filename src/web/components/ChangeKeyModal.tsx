import React, { useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.js';
import { notifyAuthSessionExpired } from '../authSession.js';
import CenteredModal from './CenteredModal.js';
import { Button, TextField } from './ui/index.js';

export default function ChangeKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [oldToken, setOldToken] = useState('');
  const [newToken, setNewToken] = useState('');
  const [confirmToken, setConfirmToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  const handleSubmit = async () => {
    setError('');
    if (!oldToken || !newToken || !confirmToken) {
      setError('请填写所有字段');
      return;
    }
    if (newToken !== confirmToken) {
      setError('两次输入的新登录凭据不一致');
      return;
    }
    if (newToken.length < 12) {
      setError('新登录凭据至少 12 个字符');
      return;
    }

    setSaving(true);
    try {
      const res = await api.changeAuthToken(oldToken, newToken);
      if (res.success) {
        toast.success('登录凭据已更新，请重新登录');
        onClose();
        setOldToken('');
        setNewToken('');
        setConfirmToken('');
        notifyAuthSessionExpired();
      } else {
        setError(res.message || '更新失败');
      }
    } catch (e: any) {
      setError(e.message || '更新失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title="修改管理员登录凭据"
      maxWidth={420}
      closeOnEscape={!saving}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} loadingLabel="更新中..." onClick={() => void handleSubmit()}>
            确认修改
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TextField
          label="当前登录凭据"
          type="password"
          autoComplete="current-password"
          value={oldToken}
          onChange={(event) => { setOldToken(event.target.value); setError(''); }}
          placeholder="输入当前登录凭据"
        />
        <TextField
          label="新登录凭据"
          type="password"
          autoComplete="new-password"
          value={newToken}
          onChange={(event) => { setNewToken(event.target.value); setError(''); }}
          placeholder="输入新登录凭据（至少 12 位）"
        />
        <TextField
          label="确认新登录凭据"
          type="password"
          autoComplete="new-password"
          value={confirmToken}
          onChange={(event) => { setConfirmToken(event.target.value); setError(''); }}
          placeholder="再次输入新登录凭据"
          onKeyDown={(event) => { if (event.key === 'Enter') void handleSubmit(); }}
        />
        {error ? <div className="alert alert-error">{error}</div> : null}
      </div>
    </CenteredModal>
  );
}
