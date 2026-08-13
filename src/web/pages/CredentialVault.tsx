import React, { useEffect, useState } from 'react';
import { api, type SiteAdapterContract } from '../api.js';
import { useToast } from '../components/Toast.js';
import { Button } from '../components/ui/index.js';
import CredentialImportJobsPanel from './credential-management/CredentialImportJobsPanel.js';
import CredentialImportPanel from './credential-management/CredentialImportPanel.js';
import CredentialInventoryPanel from './credential-management/CredentialInventoryPanel.js';
import VaultInventoryPanel from './credential-management/VaultInventoryPanel.js';
import type { SiteRow } from './credential-management/shared.js';

type WorkspaceView = 'inventory' | 'import' | 'jobs' | 'vault';

const VIEWS: Array<{ key: WorkspaceView; label: string }> = [
  { key: 'inventory', label: '统一凭证' },
  { key: 'import', label: '导入' },
  { key: 'jobs', label: '导入任务' },
  { key: 'vault', label: 'Vault' },
];

export default function CredentialVault() {
  const toast = useToast();
  const [view, setView] = useState<WorkspaceView>('inventory');
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [contracts, setContracts] = useState<SiteAdapterContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [focusJobId, setFocusJobId] = useState<string>();

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
        if (active) toast.error(error?.message || '加载凭证中心配置失败');
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadMetadata();
    return () => { active = false; };
  }, [toast]);

  const notifyChanged = () => setRefreshToken((value) => value + 1);

  const handleImported = (jobId: string) => {
    setFocusJobId(jobId);
    notifyChanged();
  };

  if (loading) {
    return (
      <div className="animate-fade-in">
        <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 20 }} />
        <div className="skeleton" style={{ width: '100%', height: 280, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in" style={{ paddingBottom: 40 }} data-testid="credential-management-workbench">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h2 className="page-title">凭证中心</h2>
          <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
            统一导入、治理和迁移 NewAPI/OneAPI、Sub2API、原生 OAuth、API Key 与 Vault 凭证；列表和任务仅展示安全摘要。
          </div>
        </div>
      </div>

      <nav className="tabs credential-management-tabs" aria-label="凭证中心导航" role="tablist">
        {VIEWS.map((item) => (
          <Button
            key={item.key}
            variant="ghost"
            role="tab"
            aria-selected={view === item.key}
            className={`tab ${view === item.key ? 'active' : ''}`}
            onClick={() => setView(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </nav>

      <div className="management-page-stack">
        {view === 'inventory' && (
          <CredentialInventoryPanel sites={sites} refreshToken={refreshToken} onChanged={notifyChanged} />
        )}
        {view === 'import' && <CredentialImportPanel sites={sites} onImported={handleImported} />}
        {view === 'jobs' && (
          <CredentialImportJobsPanel sites={sites} refreshToken={refreshToken} focusJobId={focusJobId} />
        )}
        {view === 'vault' && (
          <VaultInventoryPanel sites={sites} contracts={contracts} refreshToken={refreshToken} onChanged={notifyChanged} />
        )}
      </div>
    </div>
  );
}
