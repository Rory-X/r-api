import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type RoutingObservabilityResponse,
  type RoutingObservabilityRoute,
} from '../api.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';

type RangeHours = 24 | 168 | 720;

const RANGE_OPTIONS: Array<{ value: RangeHours; label: string }> = [
  { value: 24, label: '24 小时' },
  { value: 168, label: '7 天' },
  { value: 720, label: '30 天' },
];

function formatPercent(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%`;
}

function formatLatency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
  return `${Math.round(value)}ms`;
}

function formatCost(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  return `$${value < 0.01 ? value.toFixed(5) : value.toFixed(3)}`;
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function getStrategyLabel(value: string | null): string {
  if (value === 'round_robin') return '轮询';
  if (value === 'stable_first') return '稳定优先';
  if (value === 'manual') return '手动调度';
  if (value === 'weighted') return '权重随机';
  return '当前配置未知';
}

function getRouteKey(route: RoutingObservabilityRoute): string {
  return route.routeId == null ? 'unknown' : String(route.routeId);
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'success' | 'warning';
}) {
  return (
    <div className={`routing-observability-metric is-${tone}`}>
      <div className="routing-observability-metric-label">{label}</div>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function RouteChannelDetails({ route }: { route: RoutingObservabilityRoute }) {
  if (route.channels.length === 0) {
    return (
      <div className="routing-observability-channel-empty">
        这批历史日志没有可关联的通道记录。
      </div>
    );
  }

  return (
    <div className="routing-observability-channel-list">
      {route.channels.map((channel) => {
        const cooldownTimestamp = channel.currentCooldownUntil
          ? Date.parse(channel.currentCooldownUntil)
          : Number.NaN;
        const cooling = Number.isFinite(cooldownTimestamp) && cooldownTimestamp > Date.now();
        const healthLabel = !channel.enabled
          ? '已停用'
          : cooling
            ? '冷却中'
            : channel.currentConsecutiveFailCount > 0
              ? `连续失败 ${channel.currentConsecutiveFailCount}`
              : '当前可用';
        const healthClass = !channel.enabled
          ? 'badge-muted'
          : cooling || channel.currentConsecutiveFailCount > 0
            ? 'badge-warning'
            : 'badge-success';

        return (
          <div className="routing-observability-channel" key={channel.channelId}>
            <div className="routing-observability-channel-identity">
              <strong>{channel.label}</strong>
              <span>通道 #{channel.channelId}</span>
            </div>
            <div className="routing-observability-channel-share">
              <div>
                <span style={{
                  width: channel.selectionShare > 0
                    ? `${Math.max(2, channel.selectionShare)}%`
                    : '0%',
                }} />
              </div>
              <strong>{formatPercent(channel.selectionShare)}</strong>
              <small>{channel.selectedAttempts} 次尝试</small>
            </div>
            <div className="routing-observability-channel-outcome">
              <span>成功 {channel.successfulAttempts}</span>
              <span>失败 {channel.failedAttempts}</span>
              <span>涉及请求 {channel.selectedRequests}</span>
            </div>
            <div className="routing-observability-channel-health">
              <span className={`badge ${healthClass}`}>{healthLabel}</span>
              <small>累计失败 {channel.currentFailCount}</small>
              {cooling && channel.currentCooldownUntil ? (
                <small>至 {formatGeneratedAt(channel.currentCooldownUntil)}</small>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function RoutingObservability() {
  const isMobile = useIsMobile();
  const [hours, setHours] = useState<RangeHours>(24);
  const [data, setData] = useState<RoutingObservabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [expandedRoutes, setExpandedRoutes] = useState<Set<string>>(new Set());
  const requestSequence = useRef(0);
  const toast = useToast();

  const load = useCallback(async (silent = false) => {
    const sequence = ++requestSequence.current;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const result = await api.getRoutingObservability(hours);
      if (sequence !== requestSequence.current) return;
      setData(result);
    } catch (loadError: any) {
      if (sequence !== requestSequence.current) return;
      const message = loadError?.message || '加载调度观测数据失败';
      setError(message);
      toast.error(message);
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [hours, toast]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const funnel = useMemo(() => {
    if (!data) return [];
    return [
      { label: '进入调度', value: data.totals.requests, tone: 'neutral' },
      { label: '首次成功', value: data.totals.firstAttemptSuccessCount, tone: 'success' },
      { label: '切路由后挽救', value: data.totals.failoverRecoveredCount, tone: 'warning' },
      { label: '最终失败', value: data.totals.finalFailureCount, tone: 'danger' },
    ];
  }, [data]);

  const toggleRoute = (route: RoutingObservabilityRoute) => {
    const key = getRouteKey(route);
    setExpandedRoutes((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="routing-observability-page animate-fade-in">
      <div className="page-header routing-observability-header">
        <div>
          <div className="routing-observability-eyebrow">
            <span>路由运行观测</span>
            <span>请求 · 故障转移 · 通道分布</span>
          </div>
          <h2 className="page-title">调度观测</h2>
          <div className="page-subtitle">
            用请求级成功率、故障转移挽救和通道分布判断当前调度是否真正有效。
          </div>
        </div>
        <div className="page-actions">
          <div className="routing-observability-range" aria-label="观测时间范围">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={hours === option.value ? 'active' : ''}
                aria-pressed={hours === option.value}
                onClick={() => setHours(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => void load(true)}
            disabled={loading || refreshing}
          >
            {refreshing ? <><span className="spinner spinner-sm" /> 刷新中...</> : '刷新'}
          </button>
        </div>
      </div>

      {data ? (
        <div className="routing-observability-meta">
          <span>更新于 {formatGeneratedAt(data.generatedAt)}</span>
          <span>采样日志 {data.sampledLogRows.toLocaleString()} 条</span>
          {data.truncated ? <span className="is-warning">数据量较大，仅统计最近 100,000 条日志</span> : null}
        </div>
      ) : null}

      {data?.caveats?.length ? (
        <div className="routing-observability-caveat" role="note">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="12" cy="12" r="9" strokeWidth="1.8" />
            <path d="M12 10v6M12 7h.01" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <div>
            <strong>阅读口径</strong>
            {data.caveats.map((caveat) => <span key={caveat}>{caveat}</span>)}
          </div>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="card routing-observability-loading">
          <span className="spinner" />
          <span>正在汇总请求与尝试记录...</span>
        </div>
      ) : error && !data ? (
        <div className="card routing-observability-empty">
          <strong>暂时无法加载调度观测</strong>
          <span>{error}</span>
          <button type="button" className="btn btn-primary" onClick={() => void load(false)}>重试</button>
        </div>
      ) : data ? (
        <>
          <div className="routing-observability-metric-grid">
            <MetricCard
              label="最终成功率"
              value={formatPercent(data.totals.finalSuccessRate)}
              detail={`${data.totals.finalSuccessCount} / ${data.totals.requests} 个请求成功`}
              tone="success"
            />
            <MetricCard
              label="首次成功率"
              value={formatPercent(data.totals.firstAttemptSuccessRate)}
              detail="无需切换通道即完成"
            />
            <MetricCard
              label="故障转移挽救率"
              value={formatPercent(data.totals.failoverRecoveredRate)}
              detail={`${data.totals.failoverRecoveredCount} 个首次失败请求被挽救`}
              tone="warning"
            />
            <MetricCard
              label="平均尝试次数"
              value={data.totals.averageAttempts.toFixed(2)}
              detail={`共出现 ${data.totals.status503Count} 次 503`}
            />
            <MetricCard
              label="P95 首字延迟"
              value={formatLatency(data.totals.p95FirstByteLatencyMs)}
              detail={`请求总耗时 P95 ${formatLatency(data.totals.p95LatencyMs)}`}
            />
            <MetricCard
              label="每成功请求成本"
              value={formatCost(data.totals.successfulRequestCost)}
              detail={`范围总成本 ${formatCost(data.totals.totalCost)}`}
            />
          </div>

          <section className="card routing-observability-funnel-card">
            <div className="routing-observability-section-heading">
              <div>
                <h3>请求结果漏斗</h3>
                <p>把“调度到请求”拆成首次命中、故障转移挽救与最终失败。</p>
              </div>
            </div>
            <div className="routing-observability-funnel">
              {funnel.map((item, index) => (
                <React.Fragment key={item.label}>
                  {index > 0 ? <span className="routing-observability-funnel-arrow" aria-hidden="true">→</span> : null}
                  <div className={`routing-observability-funnel-step is-${item.tone}`}>
                    <span>{item.label}</span>
                    <strong>{item.value.toLocaleString()}</strong>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </section>

          <section className="card routing-observability-route-card">
            <div className="routing-observability-section-heading">
              <div>
                <h3>路由表现</h3>
                <p>先看请求结果，再展开检查通道命中占比和当前健康状态。</p>
              </div>
              <span className="badge badge-muted">{data.routes.length} 条有样本路由</span>
            </div>

            {data.routes.length === 0 ? (
              <div className="routing-observability-empty is-embedded">
                <strong>这个时间范围内还没有可统计的代理请求</strong>
                <span>产生请求后刷新，或切换到更长的时间范围。</span>
              </div>
            ) : isMobile ? (
              <div className="mobile-card-list routing-observability-mobile-list" data-testid="routing-observability-mobile-list">
                {data.routes.map((route) => {
                  const routeKey = getRouteKey(route);
                  const expanded = expandedRoutes.has(routeKey);
                  return (
                    <MobileCard
                      key={routeKey}
                      title={route.routeName}
                      subtitle={route.routeId == null
                        ? '无法关联 routeId'
                        : `#${route.routeId}${route.modelPattern && route.modelPattern !== route.routeName ? ` · ${route.modelPattern}` : ''}`}
                      compact
                      headerActions={<span className="badge badge-info">{getStrategyLabel(route.routingStrategy)}</span>}
                      footerActions={(
                        <button
                          type="button"
                          className="btn btn-ghost"
                          aria-label={`${expanded ? '收起' : '展开'} ${route.routeName} 通道详情`}
                          aria-expanded={expanded}
                          onClick={() => toggleRoute(route)}
                        >
                          {expanded ? '收起通道' : `查看 ${route.channels.length} 个通道`}
                        </button>
                      )}
                    >
                      <MobileField label="请求样本" value={route.requests.toLocaleString()} />
                      <MobileField label="最终成功" value={formatPercent(route.finalSuccessRate)} />
                      <MobileField label="首次成功" value={formatPercent(route.firstAttemptSuccessRate)} />
                      <MobileField label="转移挽救" value={`${route.failoverRecoveredCount} · ${formatPercent(route.failoverRecoveredRate)}`} />
                      <MobileField label="平均尝试" value={route.averageAttempts.toFixed(2)} />
                      <MobileField label="P95 总耗时" value={formatLatency(route.p95LatencyMs)} />
                      <MobileField
                        label="503"
                        value={<span className={route.status503Count > 0 ? 'routing-observability-danger-text' : ''}>{route.status503Count}</span>}
                      />
                      {expanded ? <RouteChannelDetails route={route} /> : null}
                    </MobileCard>
                  );
                })}
              </div>
            ) : (
              <div className="routing-observability-table-wrap">
                <table className="routing-observability-table">
                  <thead>
                    <tr>
                      <th>路由 / 当前策略</th>
                      <th>请求样本</th>
                      <th>最终成功</th>
                      <th>首次成功</th>
                      <th>转移挽救</th>
                      <th>平均尝试</th>
                      <th>P95 总耗时</th>
                      <th>503</th>
                      <th aria-label="展开通道详情" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.routes.map((route) => {
                      const routeKey = getRouteKey(route);
                      const expanded = expandedRoutes.has(routeKey);
                      return (
                        <React.Fragment key={routeKey}>
                          <tr className={expanded ? 'is-expanded' : ''}>
                            <td>
                              <div className="routing-observability-route-name">
                                <strong>{route.routeName}</strong>
                                <span>
                                  {route.routeId == null ? '无法关联 routeId' : `#${route.routeId}`}
                                  {route.modelPattern && route.modelPattern !== route.routeName
                                    ? ` · ${route.modelPattern}`
                                    : ''}
                                </span>
                              </div>
                              <span className="badge badge-info">当前：{getStrategyLabel(route.routingStrategy)}</span>
                            </td>
                            <td>{route.requests.toLocaleString()}</td>
                            <td><strong>{formatPercent(route.finalSuccessRate)}</strong></td>
                            <td>{formatPercent(route.firstAttemptSuccessRate)}</td>
                            <td>
                              <span>{route.failoverRecoveredCount}</span>
                              <small>{formatPercent(route.failoverRecoveredRate)}</small>
                            </td>
                            <td>{route.averageAttempts.toFixed(2)}</td>
                            <td>{formatLatency(route.p95LatencyMs)}</td>
                            <td>
                              <span className={route.status503Count > 0 ? 'routing-observability-danger-text' : ''}>
                                {route.status503Count}
                              </span>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="routing-observability-expand"
                                aria-label={`${expanded ? '收起' : '展开'} ${route.routeName} 通道详情`}
                                aria-expanded={expanded}
                                onClick={() => toggleRoute(route)}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                                  <path d="m8 10 4 4 4-4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </button>
                            </td>
                          </tr>
                          {expanded ? (
                            <tr className="routing-observability-channel-row">
                              <td colSpan={9}><RouteChannelDetails route={route} /></td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
