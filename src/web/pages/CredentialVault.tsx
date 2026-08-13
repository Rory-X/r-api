import React, { useEffect, useState } from 'react';
import { api, type SiteAdapterContract } from '../api.js';
import { useToast } from '../components/Toast.js';
import VaultInventoryPanel from './credential-management/VaultInventoryPanel.js';
import type { SiteRow } from './credential-management/shared.js';

export default function CredentialVault() {
  const toast = useToast();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [contracts, setContracts] = useState<SiteAdapterContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;
    const loadMetadata = async () => {
      setLoading(true);
      try {
        const [siteRows, contractResponse] = await Promise.all([
          api.getSites(),
          api.getSiteAdapterContracts(),
        ]);
        if (!active) return;
        setSites(Array.isArray(siteRows) ? siteRows : []);
        setContracts(Array.isArray(contractResponse?.adapters) ? contractResponse.adapters : []);
      } catch (error: any) {
        if (active) toast.error(error?.message || '加载安全凭证库配置失败');
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadMetadata();
    return () => { active = false; };
  }, [toast]);

  const notifyChanged = () => setRefreshToken((value) => value + 1);

  if (loading) {
    return (
      <div className="animate-fade-in">
        <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: '100%', height: 280, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in" style={{ paddingBottom: 40 }} data-testid="credential-vault-page">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h2 className="page-title">安全凭证库</h2>
          <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
            保存系统集成和站点辅助流程使用的加密秘密；官方订阅与 OAuth 凭证由“官方凭证池”独立管理。
          </div>
        </div>
      </div>
      <div className="management-page-stack">
        <VaultInventoryPanel
          sites={sites}
          contracts={contracts}
          refreshToken={refreshToken}
          onChanged={notifyChanged}
        />
      </div>
    </div>
  );
}
