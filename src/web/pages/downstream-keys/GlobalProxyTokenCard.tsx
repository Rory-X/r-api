import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { useToast } from '../../components/Toast.js';
import { generateDownstreamSkKey } from '../helpers/generateDownstreamSkKey.js';

const PROXY_TOKEN_PREFIX = 'sk-';

function normalizeTokenSuffix(raw: string) {
  const compact = raw.replace(/\s+/g, '');
  if (compact.toLowerCase().startsWith(PROXY_TOKEN_PREFIX)) {
    return compact.slice(PROXY_TOKEN_PREFIX.length);
  }
  return compact;
}

export default function GlobalProxyTokenCard() {
  const toast = useToast();
  const [maskedToken, setMaskedToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [tokenSuffix, setTokenSuffix] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.getRuntimeSettings()
      .then((response: any) => {
        if (active) setMaskedToken(String(response?.proxyTokenMasked || ''));
      })
      .catch(() => {
        // The managed-key list remains usable even if the compatibility token
        // cannot be loaded independently.
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setTokenSuffix('');
  };

  const saveToken = async () => {
    const suffix = tokenSuffix.trim();
    if (!suffix) {
      toast.info('请输入 sk- 后的密钥内容');
      return;
    }

    setSaving(true);
    try {
      const response: any = await api.updateRuntimeSettings({
        proxyToken: `${PROXY_TOKEN_PREFIX}${suffix}`,
      });
      setMaskedToken(String(response?.proxyTokenMasked || maskedToken));
      setModalOpen(false);
      setTokenSuffix('');
      toast.success('全局主密钥已更新');
    } catch (error: any) {
      toast.error(error?.message || '更新全局主密钥失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section
        className="card"
        data-testid="global-proxy-token-card"
        style={{
          padding: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          borderColor: 'color-mix(in srgb, var(--color-warning) 28%, var(--color-border))',
          background: 'color-mix(in srgb, var(--color-warning) 4%, var(--color-bg-card))',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 480px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>全局主密钥</strong>
            <code style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>PROXY_TOKEN</code>
            <span className="kpi-chip kpi-chip-warning">完整权限</span>
          </div>
          <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.65, color: 'var(--color-text-muted)' }}>
            供早期客户端兼容使用，可访问所有模型和路由，不受项目密钥的额度、白名单与有效期限制。新项目建议使用下方项目密钥。
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <code
            style={{
              padding: '7px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border-light)',
              background: 'var(--color-bg)',
              color: 'var(--color-text-secondary)',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {loading ? '读取中...' : (maskedToken || '未设置')}
          </code>
          <button
            type="button"
            className="btn btn-soft-primary"
            onClick={() => setModalOpen(true)}
            disabled={loading}
          >
            更换主密钥
          </button>
        </div>
      </section>

      <CenteredModal
        open={modalOpen}
        onClose={closeModal}
        title="更换全局主密钥"
        maxWidth={560}
        closeOnBackdrop
        closeOnEscape
        footer={(
          <>
            <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={saving}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => void saveToken()} disabled={saving}>
              {saving ? <><span className="spinner spinner-sm" /> 更新中...</> : '确认更换'}
            </button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid color-mix(in srgb, var(--color-warning) 32%, var(--color-border))',
              background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
              color: 'var(--color-text-secondary)',
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            更换后，仍使用旧主密钥的客户端会立即认证失败。项目密钥不受影响。
          </div>
          <div>
            <div style={{ marginBottom: 7, fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>新主密钥</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'stretch',
                overflow: 'hidden',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-bg)',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderRight: '1px solid var(--color-border-light)',
                  color: 'var(--color-text-muted)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                }}
              >
                {PROXY_TOKEN_PREFIX}
              </span>
              <input
                autoFocus
                value={tokenSuffix}
                onChange={(event) => setTokenSuffix(normalizeTokenSuffix(event.target.value))}
                placeholder="输入 sk- 后的密钥内容"
                spellCheck={false}
                style={{
                  minWidth: 0,
                  flex: 1,
                  border: 0,
                  outline: 0,
                  padding: '10px 12px',
                  background: 'transparent',
                  color: 'var(--color-text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const generated = generateDownstreamSkKey(PROXY_TOKEN_PREFIX);
                setTokenSuffix(generated.slice(PROXY_TOKEN_PREFIX.length));
              }}
            >
              随机生成安全密钥
            </button>
          </div>
        </div>
      </CenteredModal>
    </>
  );
}
