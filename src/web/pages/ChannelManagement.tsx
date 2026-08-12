import { Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { tr } from '../i18n.js';
import ChannelOverview from './channels/ChannelOverview.js';

const tabs = [
  { to: '/channels', label: '渠道总览', end: true },
  { to: '/channels/sites', label: '上游站点' },
  { to: '/channels/connections', label: '账号与 API Key' },
  { to: '/channels/oauth', label: 'OAuth' },
  { to: '/channels/recovery', label: '浏览器凭证' },
];

function ChannelSectionLoadingFallback() {
  return (
    <div className="management-page-stack" data-testid="channel-section-loading" style={{ gap: 12 }}>
      <div className="skeleton" style={{ width: '100%', height: 120 }} />
      <div className="skeleton" style={{ width: '100%', height: 280 }} />
    </div>
  );
}

export default function ChannelManagement() {
  const location = useLocation();
  const isOverview = location.pathname === '/channels' || location.pathname === '/channels/';

  return (
    <div className="animate-fade-in" data-testid="channel-management">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <h2 className="page-title">{tr('渠道管理')}</h2>
          <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
            {tr('统一管理所有 API 上游渠道，以及它们的站点、连接、OAuth 和浏览器凭证流程。')}
          </div>
        </div>
      </div>

      <nav className="tabs channel-management-tabs" aria-label={tr('渠道管理')}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}
          >
            {tr(tab.label)}
          </NavLink>
        ))}
      </nav>

      <Suspense fallback={<ChannelSectionLoadingFallback />}>
        {isOverview ? <ChannelOverview /> : <Outlet />}
      </Suspense>
    </div>
  );
}
