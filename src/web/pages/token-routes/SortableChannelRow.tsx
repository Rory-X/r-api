import { useState, type CSSProperties } from 'react';
import ModernSelect from '../../components/ModernSelect.js';
import type { SortableChannelRowProps } from './types.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
  resolveTokenBindingConnectionMode,
} from './tokenBindingPresentation.js';
import { getChannelDecisionState, getPriorityTagStyle, getProbabilityColor } from './utils.js';

type ManualSchedulingStatus = {
  label: string;
  detail: string;
  badgeClassName: string;
  color: string;
};

function getRouteUnitStrategyLabel(strategy: string | null | undefined): string {
  return strategy === 'stick_until_unavailable' ? '单个用到不可用再切' : '轮询';
}

function formatRouteUnitMemberLabel(member: { accountId: number; username: string | null; siteName: string | null }): string {
  const accountLabel = member.username?.trim() || `account-${member.accountId}`;
  const siteLabel = member.siteName?.trim();
  return siteLabel ? `${accountLabel} @ ${siteLabel}` : accountLabel;
}

function getManualSchedulingPosition(priority: number, order: number | undefined): string {
  const layerLabel = priority <= 0 ? '主用层' : `第 ${priority} 回退层`;
  return order === undefined ? layerLabel : `${layerLabel} · 第 ${order + 1} 顺位`;
}

function getManualSchedulingStatus(
  channel: SortableChannelRowProps['channel'],
  candidate: SortableChannelRowProps['decisionCandidate'],
  decisionState: ReturnType<typeof getChannelDecisionState>,
  priority: number,
  order: number | undefined,
  loadingDecision: boolean,
): ManualSchedulingStatus {
  const position = getManualSchedulingPosition(priority, order);

  if (loadingDecision) {
    return {
      label: '状态计算中',
      detail: position,
      badgeClassName: 'badge-muted',
      color: 'var(--color-text-muted)',
    };
  }

  if (channel.enabled === false) {
    return {
      label: '已停用',
      detail: `${position} · 不参与调度`,
      badgeClassName: 'badge-muted',
      color: 'var(--color-text-muted)',
    };
  }

  if (candidate && !candidate.eligible) {
    return {
      label: decisionState.reasonText || '不可用',
      detail: `${position} · 当前跳过`,
      badgeClassName: decisionState.reasonText === '冷却中' ? 'badge-error' : 'badge-warning',
      color: decisionState.reasonColor,
    };
  }

  if (candidate?.avoidedByRecentFailure || candidate?.recentlyFailed) {
    return {
      label: decisionState.reasonText || '近期失败',
      detail: `${position} · 当前避让`,
      badgeClassName: 'badge-warning',
      color: 'var(--color-warning)',
    };
  }

  if (candidate && candidate.probability > 0) {
    return {
      label: '当前首选',
      detail: position,
      badgeClassName: 'badge-success',
      color: 'var(--color-success)',
    };
  }

  return {
    label: priority <= 0 ? '同层等待' : `第 ${priority} 回退`,
    detail: position,
    badgeClassName: priority <= 0 ? 'badge-muted' : 'badge-info',
    color: priority <= 0 ? 'var(--color-text-secondary)' : 'var(--color-info)',
  };
}

function SchedulingStatus({
  manual,
  status,
  probability,
  suppressTooltips,
}: {
  manual: boolean;
  status: ManualSchedulingStatus;
  probability: ReturnType<typeof getChannelDecisionState>;
  suppressTooltips: boolean;
}) {
  if (manual) {
    return (
      <>
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>调度状态</span>
        <span
          className={`badge ${status.badgeClassName}`}
          data-testid="manual-scheduling-status"
          data-tooltip={suppressTooltips ? undefined : status.detail}
          style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}
        >
          {status.label}
        </span>
        <span style={{ fontSize: 11, color: status.color, whiteSpace: 'nowrap' }}>
          {status.detail}
        </span>
      </>
    );
  }

  return (
    <>
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 96 }}>
        <div
          data-tooltip={suppressTooltips ? undefined : (probability.probability <= 0 ? probability.reasonText : undefined)}
          style={{
            width: 60,
            height: 4,
            background: 'color-mix(in srgb, var(--color-border) 88%, white 12%)',
            borderRadius: 999,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.max(0, Math.min(100, probability.probability))}%`,
              height: '100%',
              background: getProbabilityColor(probability.probability),
              borderRadius: 999,
              transition: 'width 0.24s ease, background-color 0.18s ease',
            }}
          />
        </div>
        <span
          data-tooltip={suppressTooltips ? undefined : (probability.probability <= 0 ? probability.reasonText : undefined)}
          style={{
            fontSize: 11,
            color: probability.probability > 0 ? 'var(--color-text-secondary)' : probability.reasonColor,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {probability.probability.toFixed(1)}%
        </span>
      </div>
    </>
  );
}

function formatCooldownDeadline(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function ChannelRuntimeStatus({
  channel,
  candidate,
  routingStrategy,
  connectionMode,
  suppressTooltips,
}: {
  channel: SortableChannelRowProps['channel'];
  candidate: SortableChannelRowProps['decisionCandidate'];
  routingStrategy: NonNullable<SortableChannelRowProps['routingStrategy']>;
  connectionMode: ReturnType<typeof resolveTokenBindingConnectionMode>;
  suppressTooltips: boolean;
}) {
  const failureCount = Math.max(0, channel.failCount ?? candidate?.failureCount ?? 0);
  const consecutiveFailureCount = Math.max(
    0,
    channel.consecutiveFailCount ?? candidate?.consecutiveFailureCount ?? 0,
  );
  const cooldownUntil = channel.cooldownUntil !== undefined
    ? channel.cooldownUntil
    : candidate?.cooldownUntil;
  const cooldownTimestamp = cooldownUntil ? Date.parse(cooldownUntil) : Number.NaN;
  const cooldownActive = Number.isFinite(cooldownTimestamp) && cooldownTimestamp > Date.now();
  const cooldownDeadline = cooldownUntil ? formatCooldownDeadline(cooldownUntil) : null;
  const cooldownLabel = cooldownActive && cooldownDeadline
    ? `冷却至 ${cooldownDeadline}`
    : '未冷却';
  const cooldownTooltip = cooldownDeadline
    ? `${cooldownActive ? '当前冷却截止' : '上次冷却截止'}：${cooldownDeadline}`
    : '当前未处于冷却状态';

  const observationLabel = (() => {
    if (routingStrategy !== 'stable_first') return '观察池 —';
    if (candidate?.observationPool === 'primary') return '主池';
    if (candidate?.observationPool === 'observation') {
      const remaining = Math.max(0, candidate.observationRemainingRequests ?? 0);
      if (candidate.observationBlockedByCooldown) return '观察池 · 等待冷却';
      return candidate.observationDueNow
        ? '观察池 · 本次到期'
        : `观察池 · 剩 ${remaining} 请求`;
    }
    return '未入池';
  })();
  const observationTooltip = candidate?.observationPool === 'observation'
    ? '每完成一次主池真实请求，剩余请求数减 1；到期后放行一次观察池灰度请求。'
    : (candidate?.observationPool === 'primary'
        ? '当前通道属于稳定优先策略的主池。'
        : '当前策略不使用观察池，或该通道当前不可参与分池。');

  const stickyMode = candidate?.stickyMode
    ?? (channel.routeUnit?.strategy === 'stick_until_unavailable'
      ? 'route_unit'
      : (connectionMode === 'apikey' ? 'none' : 'session'));
  const stickyBindingCount = Math.max(0, candidate?.stickyBindingCount ?? 0);
  const stickyHit = candidate?.stickyHit ?? stickyBindingCount > 0;
  const stickyLabel = stickyHit
    ? (stickyBindingCount > 0 ? `粘黏命中 ${stickyBindingCount}` : '粘黏命中')
    : (stickyMode === 'route_unit'
        ? '池内粘黏'
        : (stickyMode === 'session' ? '粘黏未命中' : '不支持粘黏'));
  const stickyTooltip = stickyHit
    ? (stickyBindingCount > 0
        ? `当前实例有 ${stickyBindingCount} 个活跃会话绑定到该通道。`
        : '当前实例有活跃会话命中该通道。')
    : (stickyMode === 'route_unit'
        ? 'OAuth 路由池会优先沿用最近可用成员，成员不可用时再切换。'
        : (stickyMode === 'session'
            ? '支持会话粘黏，但当前实例没有活跃会话绑定到该通道。'
            : 'API Key 直连通道不启用会话粘黏。'));

  const badgeStyle: CSSProperties = {
    fontSize: 10,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  };

  return (
    <div
      data-testid="channel-runtime-status"
      style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}
    >
      <span
        className={`badge ${failureCount > 0 ? 'badge-warning' : 'badge-muted'}`}
        style={badgeStyle}
        data-tooltip={suppressTooltips ? undefined : `累计失败 ${failureCount} 次${consecutiveFailureCount > 0 ? `，连续失败 ${consecutiveFailureCount} 次` : ''}`}
      >
        失败 {failureCount}{consecutiveFailureCount > 0 ? ` · 连续 ${consecutiveFailureCount}` : ''}
      </span>
      <span
        className={`badge ${cooldownActive ? 'badge-error' : 'badge-muted'}`}
        style={badgeStyle}
        data-tooltip={suppressTooltips ? undefined : cooldownTooltip}
      >
        {cooldownLabel}
      </span>
      <span
        className={`badge ${candidate?.observationPool === 'observation' ? 'badge-warning' : 'badge-muted'}`}
        style={badgeStyle}
        data-tooltip={suppressTooltips ? undefined : observationTooltip}
      >
        {observationLabel}
      </span>
      <span
        className={`badge ${stickyHit ? 'badge-success' : 'badge-muted'}`}
        style={badgeStyle}
        data-tooltip={suppressTooltips ? undefined : stickyTooltip}
      >
        {stickyLabel}
      </span>
    </div>
  );
}

export function SortableChannelRow({
  channel,
  routingStrategy = 'weighted',
  displayPriority,
  displayOrder,
  showPriorityBadge = true,
  showDragHandle = true,
  dragging = false,
  dragHandleProps,
  dragHandleRef,
  decisionCandidate,
  isExactRoute,
  loadingDecision,
  isSavingPriority,
  schedulingEditable = true,
  readOnly = false,
  channelManagementDisabled = false,
  dragInProgress = false,
  mobile = false,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  onTokenDraftChange,
  onSaveToken,
  onDeleteChannel,
  onToggleEnabled,
}: SortableChannelRowProps) {
  const resolvedPriority = displayPriority ?? channel.priority ?? 0;
  const resolvedOrder = displayOrder ?? channel.sortOrder;
  const managementLocked = readOnly || channelManagementDisabled;
  const schedulingLocked = readOnly || !schedulingEditable;
  const displaySchedulingControls = schedulingEditable && !readOnly;
  const suppressTooltips = dragInProgress || dragging;
  const tokenBindingConnectionMode = resolveTokenBindingConnectionMode(channel.account);
  const hasTokenBindingChoices = tokenOptions.length > 0 || activeTokenId > 0;
  const showEffectiveTokenBadge = hasTokenBindingChoices || tokenBindingConnectionMode === 'session';
  const rowTransition = [
    'box-shadow 180ms ease',
    'background-color 180ms ease',
    'border-color 180ms ease',
    'opacity 180ms ease',
  ].filter(Boolean).join(', ');
  const dragHandleStyle: CSSProperties = {
    width: 22,
    minWidth: 22,
    height: 22,
    padding: 0,
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 34%, var(--color-border-light))' : 'var(--color-border-light)'}`,
    borderRadius: 10,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 80%, var(--color-info) 20%)'
      : 'color-mix(in srgb, var(--color-bg-card) 90%, white 10%)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.62)',
    color: dragging ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    cursor: isSavingPriority || schedulingLocked ? 'not-allowed' : 'grab',
    opacity: schedulingLocked ? 0.65 : 1,
    transition: 'background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease',
  };

  const rowStyle: CSSProperties = {
    transition: rowTransition || undefined,
    opacity: dragging ? 0.92 : channel.enabled === false ? 0.56 : 1,
    display: 'grid',
    gridTemplateColumns: managementLocked || mobile
      ? 'minmax(0, 1fr)'
      : (hasTokenBindingChoices ? 'minmax(0, 1fr) auto auto auto' : 'minmax(0, 1fr) auto auto'),
    alignItems: mobile ? 'stretch' : 'center',
    gap: mobile ? 8 : 6,
    padding: mobile ? '8px 9px' : '5px 8px',
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 38%, var(--color-border-light))' : 'color-mix(in srgb, var(--color-border-light) 92%, transparent)'}`,
    borderRadius: 14,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 82%, var(--color-info) 18%)'
      : 'color-mix(in srgb, var(--color-bg-card) 96%, white 4%)',
    boxShadow: dragging
      ? '0 18px 34px rgba(15, 23, 42, 0.12)'
      : '0 10px 22px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
  };

  const decisionState = getChannelDecisionState(decisionCandidate, channel, isExactRoute, loadingDecision);
  const manualScheduling = routingStrategy === 'manual';
  const manualSchedulingStatus = getManualSchedulingStatus(
    channel,
    decisionCandidate,
    decisionState,
    resolvedPriority,
    resolvedOrder,
    loadingDecision,
  );
  const tokenBinding = describeTokenBinding(
    tokenOptions,
    activeTokenId,
    channel.token?.name ?? null,
    {
      connectionMode: tokenBindingConnectionMode,
      accountName: channel.account?.username || `account-${channel.accountId}`,
    },
  );
  const routeUnit = channel.routeUnit ?? null;
  const routeUnitName = routeUnit?.name?.trim() || 'OAuth 路由池';
  const routeUnitStrategyLabel = routeUnit ? getRouteUnitStrategyLabel(routeUnit.strategy) : '';
  const routeUnitMemberSummary = routeUnit?.members?.length
    ? routeUnit.members.map((member) => formatRouteUnitMemberLabel(member)).join('、')
    : null;
  const routeUnitMemberSummaryText = routeUnitMemberSummary ? `成员：${routeUnitMemberSummary}` : null;

  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);

  if (mobile) {
    return (
      <div data-layer-root style={{ ...rowStyle, display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          {showDragHandle && displaySchedulingControls ? (
            <button
              type="button"
              ref={dragHandleRef}
              {...dragHandleProps}
              disabled={isSavingPriority || schedulingLocked}
              className="btn btn-ghost"
              style={{
                marginTop: 2,
                ...dragHandleStyle,
              }}
              data-tooltip={suppressTooltips ? undefined : '拖拽调整优先级层或组内顺序'}
              aria-label="拖拽调整优先级层或组内顺序"
            >
              <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
                <circle cx="3" cy="2" r="1" />
                <circle cx="9" cy="2" r="1" />
                <circle cx="3" cy="6" r="1" />
                <circle cx="9" cy="6" r="1" />
                <circle cx="3" cy="10" r="1" />
                <circle cx="9" cy="10" r="1" />
              </svg>
            </button>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              {showPriorityBadge ? (
                <span
                  className="badge"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.1,
                    ...getPriorityTagStyle(resolvedPriority),
                  }}
                >
                  P{resolvedPriority}
                </span>
              ) : null}

              {displaySchedulingControls && resolvedOrder !== undefined ? (
                <span
                  className="badge badge-muted"
                  aria-label={`组内顺序第 ${resolvedOrder + 1}`}
                  data-tooltip={suppressTooltips ? undefined : '同一优先级层内从上到下依次调度'}
                  style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
                >
                  #{resolvedOrder + 1}
                </span>
              ) : null}

              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: 14, minWidth: 0 }}>
                {channel.account?.username || `account-${channel.accountId}`}
              </span>

              <span className="badge badge-muted" style={{ fontSize: 10 }}>
                {channel.site?.name || 'unknown'}
              </span>

              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                成功 <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: tokenBinding.badgeTone === 'info'
                    ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
                    : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
                  color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
                }}
              >
                {tokenBinding.bindingModeLabel}
              </span>

              {showEffectiveTokenBadge ? (
                <span
                  className="badge"
                  style={{
                    fontSize: 10,
                    background: 'var(--color-info-soft)',
                    color: 'var(--color-info)',
                    maxWidth: 220,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
                >
                  当前生效：{tokenBinding.effectiveTokenName}
                </span>
              ) : null}

              {channel.sourceModel ? (
                <span className="badge badge-info" style={{ fontSize: 10 }}>
                  {channel.sourceModel}
                </span>
              ) : null}

              {channel.manualOverride ? (
                <span
                  className="badge badge-warning"
                  style={{ fontSize: 10 }}
                  data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
                >
                  手动配置
                </span>
              ) : null}

              {routeUnit ? (
                <>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    OAuth 路由池
                  </span>
                  <span className="badge badge-info" style={{ fontSize: 10 }}>
                    {routeUnitName}
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnit.memberCount} 成员
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnitStrategyLabel}
                  </span>
                </>
              ) : null}
            </div>

            {routeUnitMemberSummaryText ? (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
                  {routeUnitMemberSummaryText}
                </span>
              </div>
            ) : null}

            <ChannelRuntimeStatus
              channel={channel}
              candidate={decisionCandidate}
              routingStrategy={routingStrategy}
              connectionMode={tokenBindingConnectionMode}
              suppressTooltips={suppressTooltips}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <SchedulingStatus
                manual={manualScheduling}
                status={manualSchedulingStatus}
                probability={decisionState}
                suppressTooltips={suppressTooltips}
              />

              {!managementLocked && hasTokenBindingChoices ? (
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setMobileDetailsOpen((current) => !current)}
                  style={{ marginLeft: 'auto' }}
                >
                  {mobileDetailsOpen ? '收起配置' : '配置通道'}
                </button>
              ) : null}
            </div>

            {!managementLocked && hasTokenBindingChoices && mobileDetailsOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: '1px solid var(--color-border-light)' }}>
                <div style={{ width: '100%' }}>
                  <ModernSelect
                    size="sm"
                    value={String(activeTokenId || 0)}
                    onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
                    disabled={isUpdatingToken}
                    options={[
                      {
                        value: '0',
                        label: tokenBinding.followOptionLabel,
                        description: tokenBinding.followOptionDescription,
                      },
                      ...tokenOptions.map((token) => ({
                        value: String(token.id),
                        label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                        description: buildFixedTokenOptionDescription(token),
                      })),
                    ]}
                    placeholder="选择令牌绑定方式"
                  />
                  <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
                    {tokenBinding.helperText}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={onSaveToken}
                    disabled={isUpdatingToken}
                    className="btn btn-link btn-link-info"
                  >
                    {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
                  </button>

                  <button
                    onClick={() => onToggleEnabled(channel.enabled === false)}
                    className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
                  >
                    {channel.enabled === false ? '启用' : '禁用'}
                  </button>

                  <button
                    onClick={onDeleteChannel}
                    className="btn btn-link btn-link-danger"
                  >
                    移除
                  </button>
                </div>
              </div>
            ) : null}

            {!managementLocked && !hasTokenBindingChoices ? (
              <div
                data-testid="direct-channel-actions"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 10,
                  flexWrap: 'wrap',
                  paddingTop: 6,
                  borderTop: '1px solid var(--color-border-light)',
                }}
              >
                <button
                  onClick={() => onToggleEnabled(channel.enabled === false)}
                  className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
                >
                  {channel.enabled === false ? '启用' : '禁用'}
                </button>

                <button
                  onClick={onDeleteChannel}
                  className="btn btn-link btn-link-danger"
                >
                  移除
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-layer-root style={rowStyle}>
      <div style={{ display: 'flex', alignItems: mobile ? 'stretch' : 'center', flexDirection: mobile ? 'column' : 'row', gap: 6, fontSize: 12, flexWrap: 'wrap', minWidth: 0 }}>
        {showDragHandle && displaySchedulingControls ? (
          <button
            type="button"
            ref={dragHandleRef}
            {...dragHandleProps}
            disabled={isSavingPriority || schedulingLocked}
            className="btn btn-ghost"
            style={dragHandleStyle}
            data-tooltip={suppressTooltips ? undefined : '拖拽调整优先级层或组内顺序'}
            aria-label="拖拽调整优先级层或组内顺序"
          >
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
              <circle cx="3" cy="2" r="1" />
              <circle cx="9" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" />
              <circle cx="9" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" />
              <circle cx="9" cy="10" r="1" />
            </svg>
          </button>
        ) : null}

        {showPriorityBadge ? (
          <span
            className="badge"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.1,
              ...getPriorityTagStyle(resolvedPriority),
            }}
          >
            P{resolvedPriority}
          </span>
        ) : null}

        {displaySchedulingControls && resolvedOrder !== undefined ? (
          <span
            className="badge badge-muted"
            aria-label={`组内顺序第 ${resolvedOrder + 1}`}
            data-tooltip={suppressTooltips ? undefined : '同一优先级层内从上到下依次调度'}
            style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
          >
            #{resolvedOrder + 1}
          </span>
        ) : null}

        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {channel.account?.username || `account-${channel.accountId}`}
        </span>

        <span className="badge badge-muted" style={{ fontSize: 10 }}>
          {channel.site?.name || 'unknown'}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: tokenBinding.badgeTone === 'info'
              ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
              : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
            color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
          }}
        >
          {tokenBinding.bindingModeLabel}
        </span>

        {showEffectiveTokenBadge ? (
          <span
            className="badge"
            style={{
              fontSize: 10,
              background: 'var(--color-info-soft)',
              color: 'var(--color-info)',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
          >
            当前生效：{tokenBinding.effectiveTokenName}
          </span>
        ) : null}

        {channel.sourceModel ? (
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {channel.sourceModel}
          </span>
        ) : null}

        {channel.manualOverride ? (
          <span
            className="badge badge-warning"
            style={{ fontSize: 10 }}
            data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
          >
            手动配置
          </span>
        ) : null}

        {channel.enabled === false ? (
          <span className="badge badge-muted" style={{ fontSize: 10 }}>已禁用</span>
        ) : null}

        {routeUnit ? (
          <>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              OAuth 路由池
            </span>
            <span className="badge badge-info" style={{ fontSize: 10 }}>
              {routeUnitName}
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnit.memberCount} 成员
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnitStrategyLabel}
            </span>
          </>
        ) : null}

        {routeUnitMemberSummaryText ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
              成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
              {routeUnitMemberSummaryText}
            </span>
          </div>
        ) : null}

        <ChannelRuntimeStatus
          channel={channel}
          candidate={decisionCandidate}
          routingStrategy={routingStrategy}
          connectionMode={tokenBindingConnectionMode}
          suppressTooltips={suppressTooltips}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginTop: mobile ? 0 : 1, flexWrap: 'wrap' }}>
          <SchedulingStatus
            manual={manualScheduling}
            status={manualSchedulingStatus}
            probability={decisionState}
            suppressTooltips={suppressTooltips}
          />

          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>成功</span>
          <span style={{ fontSize: 11 }}>
            <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
          </span>
        </div>
      </div>

      {!managementLocked ? (
        <>
          {hasTokenBindingChoices ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ minWidth: 220, flex: 1 }}>
                <ModernSelect
                  size="sm"
                  value={String(activeTokenId || 0)}
                  onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
                  disabled={isUpdatingToken}
                  options={[
                    {
                      value: '0',
                      label: tokenBinding.followOptionLabel,
                      description: tokenBinding.followOptionDescription,
                    },
                    ...tokenOptions.map((token) => ({
                      value: String(token.id),
                      label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                      description: buildFixedTokenOptionDescription(token),
                    })),
                  ]}
                  placeholder="选择令牌绑定方式"
                />
                <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
                  {tokenBinding.helperText}
                </div>
              </div>
              <button
                onClick={onSaveToken}
                disabled={isUpdatingToken}
                className="btn btn-link btn-link-info"
              >
                {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
              </button>
            </div>
          ) : null}

          <button
            onClick={() => onToggleEnabled(channel.enabled === false)}
            className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
            data-tooltip={suppressTooltips ? undefined : (channel.enabled === false ? '启用此通道' : '禁用此通道')}
          >
            {channel.enabled === false ? '启用' : '禁用'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <button
              onClick={onDeleteChannel}
              className="btn btn-link btn-link-danger"
            >
              移除
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
