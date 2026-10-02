import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type ChannelOverviewChannel, type ChannelsOverviewResponse } from '../../api.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { useToast } from '../../components/Toast.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { tr } from '../../i18n.js';
import { resolveChannelPath } from './navigation.js';

type RuntimeHealthRow = ChannelOverviewChannel['runtimeHealth'][number];

function normalizeStatus(value?: string | null): string {
  return String(value || 'active').trim().toLowerCase() || 'active';
}

function platformLabel(value?: string | null): string {
  const normalized = String(value || '').trim();
  return normalized || tr('未识别平台');
}

function formatRemainingMs(remainingMs: number): string {
  const safeMs = Math.max(0, Number(remainingMs) || 0);
  if (safeMs <= 0) return tr('等待半开探针');
  if (safeMs >= 60_000) return `${Math.ceil(safeMs / 60_000)} ${tr('分钟')}`;
  return `${Math.ceil(safeMs / 1000)} ${tr('秒')}`;
}

function resolveCoolingApiEndpoint(site: ChannelOverviewChannel) {
  const nowMs = Date.now();
  return (site.apiEndpoints || []).find((endpoint) => (
    endpoint.enabled !== false
    && !!endpoint.cooldownUntil
    && Date.parse(endpoint.cooldownUntil) > nowMs
  )) || null;
}

function resolvePrimaryRuntimeHealth(rows?: RuntimeHealthRow[]): RuntimeHealthRow | null {
  const activeRows = (rows || []).filter((row) => row.state !== 'healthy');
  return [...activeRows].sort((left, right) => {
    const stateDifference = (left.state === 'open' ? 0 : 1) - (right.state === 'open' ? 0 : 1);
    if (stateDifference !== 0) return stateDifference;
    return (left.scope === 'site' ? 0 : 1) - (right.scope === 'site' ? 0 : 1);
  })[0] || null;
}

function resolveFirstByteRuntimeHealth(rows?: RuntimeHealthRow[]): RuntimeHealthRow | null {
  const measuredRows = (rows || []).filter((row) => (
    Number(row.firstByteSampleCount) > 0
    && Number.isFinite(Number(row.firstByteLatencyEmaMs))
    && Number(row.firstByteLatencyEmaMs) > 0
  ));
  return [...measuredRows].sort((left, right) => {
    const multiplierDifference = Number(left.firstByteMultiplier ?? 1) - Number(right.firstByteMultiplier ?? 1);
    if (Math.abs(multiplierDifference) > 1e-9) return multiplierDifference;
    return (left.scope === 'model' ? 0 : 1) - (right.scope === 'model' ? 0 : 1);
  })[0] || null;
}

function runtimeScopeLabel(runtimeHealth: RuntimeHealthRow): string {
  if (runtimeHealth.scope === 'model') {
    return `${tr('模型')} ${runtimeHealth.modelName || '-'}`;
  }
  if (runtimeHealth.lastFailureEndpointId) {
    return `${tr('API 端点')} #${runtimeHealth.lastFailureEndpointId}`;
  }
  return tr('站点主地址');
}

export default function ChannelOverview() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const isMobile = useIsMobile();
  const [overview, setOverview] = useState<ChannelsOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setOverview(await api.getChannelsOverview());
    } catch (error: any) {
      toast.error(error?.message || tr('加载渠道概览失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const summaries = overview?.channels || [];
  const totals = overview?.totals || {
    sites: 0,
    officialConnections: 0,
    ordinaryConnections: 0,
    activeCredentials: 0,
  };

  if (loading) {
    return (
      <div className="management-page-stack" style={{ gap: 12 }}>
        <div className="skeleton" style={{ width: '100%', height: 120 }} />
        <div className="skeleton" style={{ width: '100%', height: 280 }} />
      </div>
    );
  }

  return (
    <div className="management-page-stack" style={{ gap: 16 }} data-testid="channel-overview">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <h3 className="page-title" style={{ fontSize: 18 }}>{tr('渠道总览')}</h3>
          <div style={{ marginTop: 6, color: 'var(--color-text-muted)', fontSize: 12 }}>
            {tr('每一行都是一个可供 r-api 聚合和路由的 API 上游渠道。')}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={() => navigate(resolveChannelPath(location.pathname, 'official'))}>{tr('官方渠道')}</button>
          <button className="btn btn-primary" onClick={() => navigate(`${resolveChannelPath(location.pathname, 'sites')}?create=1`)}>{tr('添加上游渠道')}</button>
        </div>
      </div>

      <div className="channel-summary-strip">
        <div className="channel-summary-metric"><strong>{totals.sites}</strong><span>{tr('个上游站点')}</span></div>
        <div className="channel-summary-metric"><strong>{totals.officialConnections}</strong><span>{tr('个官方渠道')}</span></div>
        <div className="channel-summary-metric"><strong>{totals.ordinaryConnections}</strong><span>{tr('个普通连接')}</span></div>
        <div className="channel-summary-metric"><strong>{totals.activeCredentials}</strong><span>{tr('个渠道凭证')}</span></div>
      </div>

      {summaries.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">{tr('还没有上游渠道')}</div>
          <div className="empty-state-description">{tr('先添加一个站点，再在渠道管理中选择账号、API Key 或浏览器凭证接入方式。')}</div>
          <button className="btn btn-primary" onClick={() => navigate(`${resolveChannelPath(location.pathname, 'sites')}?create=1`)}>{tr('添加第一个渠道')}</button>
        </div>
      ) : isMobile ? (
        <div className="mobile-card-list" data-testid="channel-overview-mobile-list">
          {summaries.map((channel) => {
            const disabled = normalizeStatus(channel.status) === 'disabled';
            const runtimeHealth = resolvePrimaryRuntimeHealth(channel.runtimeHealth);
            const firstByteHealth = resolveFirstByteRuntimeHealth(channel.runtimeHealth);
            const coolingEndpoint = runtimeHealth ? null : resolveCoolingApiEndpoint(channel);
            const endpointCount = Array.isArray(channel.apiEndpoints)
              ? channel.apiEndpoints.filter((endpoint) => endpoint.enabled !== false).length
              : 0;
            const statusLabel = disabled
              ? tr('已禁用')
              : runtimeHealth?.state === 'open'
                ? tr('熔断中')
                : runtimeHealth?.state === 'recovering'
                  ? tr('恢复观察中')
                  : coolingEndpoint
                    ? tr('端点冷却中')
                    : tr('可用');
            const statusClass = disabled
              ? 'badge-warning'
              : runtimeHealth?.state === 'open' || coolingEndpoint
                ? 'badge-error'
                : runtimeHealth?.state === 'recovering'
                  ? 'badge-warning'
                  : 'badge-success';

            return (
              <MobileCard
                key={channel.id}
                title={channel.name}
                subtitle={channel.url}
                compact
                headerActions={<span className={`badge ${statusClass}`}>{statusLabel}</span>}
                footerActions={(
                  <>
                    <button className="btn btn-ghost" onClick={() => navigate(`${resolveChannelPath(location.pathname, 'sites')}?focusSiteId=${channel.id}`)}>{tr('站点')}</button>
                    <button className="btn btn-primary" onClick={() => navigate(`${resolveChannelPath(location.pathname, 'connections')}?siteId=${channel.id}`)}>{tr('连接')}</button>
                  </>
                )}
              >
                <MobileField label={tr('平台')} value={<span className="badge badge-muted">{platformLabel(channel.platform)}</span>} />
                <MobileField label={tr('连接')} value={`${channel.activeConnectionCount}/${channel.connectionCount} ${tr('活跃')}`} />
                <MobileField label={tr('凭证')} value={channel.credentialCount} />
                <MobileField label={tr('API 端点')} value={endpointCount} />
                {runtimeHealth && !disabled ? (
                  <MobileField
                    stacked
                    label={tr('调度健康')}
                    value={(
                      <span>
                        {runtimeScopeLabel(runtimeHealth)} · {tr('级别')} {runtimeHealth.breakerLevel}
                        {runtimeHealth.state === 'open'
                          ? ` · ${runtimeHealth.probeInFlight ? tr('半开探针执行中') : formatRemainingMs(runtimeHealth.remainingMs)}`
                          : ` · ${runtimeHealth.recoverySuccessCount}/${runtimeHealth.recoverySuccessThreshold} · ${Math.round(runtimeHealth.recoveryTrafficRatio * 100)}% ${tr('流量')}`}
                        {runtimeHealth.lastFailureReason ? ` · ${runtimeHealth.lastFailureReason}` : ''}
                      </span>
                    )}
                  />
                ) : null}
                {coolingEndpoint && !disabled ? (
                  <MobileField
                    stacked
                    label={tr('冷却端点')}
                    value={`${coolingEndpoint.id ? `#${coolingEndpoint.id} · ` : ''}${formatRemainingMs(Date.parse(coolingEndpoint.cooldownUntil || '') - Date.now())}${coolingEndpoint.lastFailureReason ? ` · ${coolingEndpoint.lastFailureReason}` : ''}`}
                  />
                ) : null}
                {firstByteHealth && Number(firstByteHealth.firstByteMultiplier ?? 1) < 0.999 && !disabled ? (
                  <MobileField
                    label={tr('首字性能')}
                    value={`${Math.round(Number(firstByteHealth.firstByteLatencyEmaMs))}ms · ${(Number(firstByteHealth.firstByteMultiplier) * 100).toFixed(0)}%`}
                  />
                ) : null}
              </MobileCard>
            );
          })}
        </div>
      ) : (
        <div className="card channel-overview-table-wrap" style={{ padding: 0 }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{tr('渠道')}</th>
                <th>{tr('平台')}</th>
                <th>{tr('连接')}</th>
                <th>{tr('凭证')}</th>
                <th>{tr('状态')}</th>
                <th style={{ textAlign: 'right' }}>{tr('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((channel) => {
                const disabled = normalizeStatus(channel.status) === 'disabled';
                const runtimeHealth = resolvePrimaryRuntimeHealth(channel.runtimeHealth);
                const firstByteHealth = resolveFirstByteRuntimeHealth(channel.runtimeHealth);
                const coolingEndpoint = runtimeHealth ? null : resolveCoolingApiEndpoint(channel);
                const endpointCount = Array.isArray(channel.apiEndpoints)
                  ? channel.apiEndpoints.filter((endpoint) => endpoint.enabled !== false).length
                  : 0;
                return (
                  <tr key={channel.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{channel.name}</div>
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 3 }}>{channel.url}</div>
                    </td>
                    <td><span className="badge badge-muted">{platformLabel(channel.platform)}</span></td>
                    <td>{channel.activeConnectionCount}/{channel.connectionCount}<span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}> {tr('活跃')}</span></td>
                    <td>{channel.credentialCount}</td>
                    <td>
                      <span className={`badge ${disabled ? 'badge-warning' : runtimeHealth?.state === 'open' || coolingEndpoint ? 'badge-error' : runtimeHealth?.state === 'recovering' ? 'badge-warning' : 'badge-success'}`}>
                        {disabled
                          ? tr('已禁用')
                          : runtimeHealth?.state === 'open'
                            ? tr('熔断中')
                            : runtimeHealth?.state === 'recovering'
                              ? tr('恢复观察中')
                              : coolingEndpoint
                                ? tr('端点冷却中')
                              : tr('可用')}
                      </span>
                      {runtimeHealth && !disabled && (
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 4, maxWidth: 280 }}>
                          <div>
                            {runtimeScopeLabel(runtimeHealth)} · {tr('级别')} {runtimeHealth.breakerLevel}
                            {runtimeHealth.state === 'open'
                              ? ` · ${runtimeHealth.probeInFlight ? tr('半开探针执行中') : formatRemainingMs(runtimeHealth.remainingMs)}`
                              : ` · ${runtimeHealth.recoverySuccessCount}/${runtimeHealth.recoverySuccessThreshold} · ${Math.round(runtimeHealth.recoveryTrafficRatio * 100)}% ${tr('流量')}`}
                          </div>
                          {runtimeHealth.lastFailureReason && (
                            <div title={runtimeHealth.lastFailureReason} style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {runtimeHealth.lastFailureDomain ? `${runtimeHealth.lastFailureDomain}: ` : ''}{runtimeHealth.lastFailureReason}
                            </div>
                          )}
                        </div>
                      )}
                      {firstByteHealth && Number(firstByteHealth.firstByteMultiplier ?? 1) < 0.999 && !disabled && (
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 4, maxWidth: 280 }}>
                          {runtimeScopeLabel(firstByteHealth)} · {tr('首字 EMA')} {Math.round(Number(firstByteHealth.firstByteLatencyEmaMs))}ms
                          {' · '}{firstByteHealth.firstByteSampleCount} {tr('样本')}
                          {' · '}{tr('调度倍率')} {(Number(firstByteHealth.firstByteMultiplier) * 100).toFixed(0)}%
                        </div>
                      )}
                      {coolingEndpoint && !disabled && (
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 4, maxWidth: 280 }}>
                          <div>
                            {tr('API 端点')} {coolingEndpoint.id ? `#${coolingEndpoint.id}` : ''} · {formatRemainingMs(Date.parse(coolingEndpoint.cooldownUntil || '') - Date.now())}
                          </div>
                          {coolingEndpoint.lastFailureReason && (
                            <div title={coolingEndpoint.lastFailureReason} style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              endpoint: {coolingEndpoint.lastFailureReason}
                            </div>
                          )}
                        </div>
                      )}
                      {endpointCount > 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 3 }}>{endpointCount} {tr('个 API 端点')}</div>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-link" onClick={() => navigate(`${resolveChannelPath(location.pathname, 'sites')}?focusSiteId=${channel.id}`)}>{tr('站点')}</button>
                      <button className="btn btn-link" onClick={() => navigate(`${resolveChannelPath(location.pathname, 'connections')}?siteId=${channel.id}`)}>{tr('连接')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
