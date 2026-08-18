import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableChannelRow } from './SortableChannelRow.js';
import type { RouteChannel } from './types.js';

function buildChannel(overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id: 301,
    routeId: 88,
    accountId: 7,
    tokenId: null,
    sourceModel: 'gpt-4.1',
    priority: 0,
    sortOrder: 0,
    weight: 100,
    enabled: true,
    manualOverride: true,
    successCount: 12,
    failCount: 1,
    cooldownUntil: null,
    account: {
      username: 'cc',
      accessToken: null,
      extraConfig: null,
      credentialMode: 'oauth',
    },
    site: {
      id: 99,
      name: 'codelab',
      platform: 'openai',
    },
    token: null,
    ...overrides,
  };
}

function collectText(node: { children?: Array<string | { children?: unknown[] }> }): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child as { children?: Array<string | { children?: unknown[] }> })
  )).join('');
}

describe('SortableChannelRow layering', () => {
  it('hides credential configuration for direct API Key channels while keeping channel actions', () => {
    const channel = buildChannel({
      account: {
        username: 'direct-key',
        accessToken: null,
        extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
        credentialMode: 'apikey',
      },
    });

    for (const mobile of [false, true]) {
      const root = create(
        <DndContext>
          <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
            <SortableChannelRow
              channel={channel}
              mobile={mobile}
              decisionCandidate={undefined}
              isExactRoute
              loadingDecision={false}
              isSavingPriority={false}
              tokenOptions={[]}
              activeTokenId={0}
              isUpdatingToken={false}
              onTokenDraftChange={vi.fn()}
              onSaveToken={vi.fn()}
              onDeleteChannel={vi.fn()}
              onToggleEnabled={vi.fn()}
            />
          </SortableContext>
        </DndContext>,
      );
      const text = collectText(root.root);

      expect(text).toContain('API Key直连');
      expect(text).not.toContain('配置通道');
      expect(text).not.toContain('收起配置');
      expect(text).not.toContain('当前生效：direct-key');
      expect(root.root.findAll((node) => node.type === 'button' && collectText(node).includes('保存'))).toHaveLength(0);
      expect(root.root.findAll((node) => node.type === 'button' && collectText(node).includes('禁用'))).toHaveLength(1);
      expect(root.root.findAll((node) => node.type === 'button' && collectText(node).includes('站点屏蔽'))).toHaveLength(0);
      expect(root.root.findAll((node) => node.type === 'button' && collectText(node).includes('移除'))).toHaveLength(1);
    }
  });

  it('keeps credential configuration for session channels with token choices', () => {
    const channel = buildChannel({
      account: {
        username: 'panel-account',
        accessToken: 'session-token',
        extraConfig: JSON.stringify({ credentialMode: 'session' }),
        credentialMode: 'session',
      },
    });
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            mobile
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[{ id: 501, name: 'shared-token', isDefault: true }]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const configureButton = root.root.find((node) => (
      node.type === 'button' && collectText(node) === '配置通道'
    ));
    act(() => configureButton.props.onClick());

    expect(collectText(root.root)).toContain('收起配置');
    expect(root.root.findAll((node) => node.type === 'button' && collectText(node).includes('保存'))).toHaveLength(1);
  });

  it('does not force a base z-index on desktop rows when they are not being dragged', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const row = root.root.find((node) => (
      node.type === 'div'
      && node.props['data-layer-root']
    ));

    expect(row.props.style.zIndex).toBeUndefined();
    expect(row.props.style.borderLeft).toBeUndefined();
  });

  it('disables row tooltips while a drag interaction is in progress', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            dragInProgress
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const tooltipNodes = root.root.findAll((node) => node.props['data-tooltip'] !== undefined);
    expect(tooltipNodes).toHaveLength(0);
  });

  it('keeps scheduling controls available when only channel management is disabled', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            channelManagementDisabled
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const dragHandle = root.root.find((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '拖拽调整优先级层或组内顺序'
    ));
    const orderBadge = root.root.findByProps({ 'aria-label': '组内顺序第 1' });

    expect(dragHandle.props.disabled).toBe(false);
    expect(dragHandle.props['data-tooltip']).toBe('拖拽调整优先级层或组内顺序');
    expect(collectText(orderBadge)).toBe('#1');
  });

  it('hides scheduling controls outside manual scheduling mode', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            schedulingEditable={false}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const dragHandles = root.root.findAll((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '拖拽调整优先级层或组内顺序'
    ));

    expect(dragHandles).toHaveLength(0);
    expect(root.root.findAll((node) => String(node.props['aria-label'] || '').startsWith('组内顺序第'))).toHaveLength(0);
    expect(root.root.findAll((node) => node.type === 'button' && collectText(node).includes('禁用'))).toHaveLength(1);
  });

  it('hides explicit-group management and automatic scheduling controls', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            channelManagementDisabled
            schedulingEditable={false}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(root.root.findAll((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '拖拽调整优先级层或组内顺序'
    ))).toHaveLength(0);
    expect(root.root.findAll((node) => String(node.props['aria-label'] || '').startsWith('组内顺序第'))).toHaveLength(0);
    expect(root.root.findAll((node) => (
      node.type === 'button'
      && ['禁用', '移除', '保存'].some((label) => collectText(node).includes(label))
    ))).toHaveLength(0);
  });

  it('hides all editable channel controls for a read-only row', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            readOnly
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(root.root.findAll((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '拖拽调整优先级层或组内顺序'
    ))).toHaveLength(0);
    expect(root.root.findAll((node) => String(node.props['aria-label'] || '').startsWith('组内顺序第'))).toHaveLength(0);
    expect(root.root.findAll((node) => (
      node.type === 'button'
      && ['禁用', '移除', '保存'].some((label) => collectText(node).includes(label))
    ))).toHaveLength(0);
  });

  it('renders the persisted group order without exposing a weight editor', () => {
    const channel = buildChannel({ sortOrder: 2, weight: 100 });
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(collectText(root.root.findByProps({ 'aria-label': '组内顺序第 3' }))).toBe('#3');
    expect(root.root.findAll((node) => node.type === 'input' && node.props.type === 'number')).toHaveLength(0);
  });

  it('shows deterministic manual scheduling roles instead of probability percentages', () => {
    const primary = buildChannel({ id: 301, priority: 0, sortOrder: 0 });
    const waiting = buildChannel({ id: 302, priority: 0, sortOrder: 1 });
    const fallback = buildChannel({ id: 303, priority: 1, sortOrder: 0 });
    const renderRow = (channel: RouteChannel, probability: number, mobile = false) => create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            routingStrategy="manual"
            displayPriority={channel.priority}
            displayOrder={channel.sortOrder}
            mobile={mobile}
            decisionCandidate={{
              channelId: channel.id,
              accountId: channel.accountId,
              username: channel.account?.username || 'cc',
              siteName: channel.site?.name || 'codelab',
              tokenName: 'default',
              priority: channel.priority,
              sortOrder: channel.sortOrder || 0,
              weight: channel.weight,
              eligible: true,
              recentlyFailed: false,
              avoidedByRecentFailure: false,
              probability,
              reason: probability > 0 ? '当前首个可用通道' : '等待前序可用通道',
            }}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const primaryText = collectText(renderRow(primary, 100).root);
    const waitingText = collectText(renderRow(waiting, 0).root);
    const fallbackText = collectText(renderRow(fallback, 0, true).root);

    expect(primaryText).toContain('调度状态当前首选主用层 · 第 1 顺位');
    expect(waitingText).toContain('调度状态同层等待主用层 · 第 2 顺位');
    expect(fallbackText).toContain('调度状态第 1 回退第 1 回退层 · 第 1 顺位');
    expect(primaryText).not.toContain('选中概率');
    expect(primaryText).not.toContain('100.0%');
    expect(waitingText).not.toContain('0.0%');
  });

  it('keeps the manual position while showing an unavailable reason', () => {
    const channel = buildChannel({ priority: 0, sortOrder: 0, cooldownUntil: '2999-01-01T00:00:00.000Z' });
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            routingStrategy="manual"
            displayPriority={0}
            displayOrder={0}
            decisionCandidate={{
              channelId: channel.id,
              accountId: channel.accountId,
              username: 'cc',
              siteName: 'codelab',
              tokenName: 'default',
              priority: 0,
              sortOrder: 0,
              weight: channel.weight,
              eligible: false,
              recentlyFailed: false,
              avoidedByRecentFailure: false,
              probability: 0,
              reason: '冷却中',
            }}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const text = collectText(root.root);
    expect(text).toContain('调度状态冷却中主用层 · 第 1 顺位 · 当前跳过');
    expect(text).not.toContain('选中概率');
  });

  it('shows failure, cooldown, observation-pool and sticky status on every channel row', () => {
    const channel = buildChannel({
      failCount: 6,
      consecutiveFailCount: 2,
      cooldownUntil: '2999-01-01T00:00:00.000Z',
    });
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            routingStrategy="stable_first"
            decisionCandidate={{
              channelId: channel.id,
              accountId: channel.accountId,
              username: 'cc',
              siteName: 'codelab',
              tokenName: 'default',
              priority: 0,
              sortOrder: 0,
              weight: channel.weight,
              eligible: false,
              recentlyFailed: true,
              avoidedByRecentFailure: true,
              failureCount: 6,
              consecutiveFailureCount: 2,
              cooldownUntil: channel.cooldownUntil,
              observationPool: 'observation',
              observationRemainingRequests: 8,
              observationDueNow: false,
              stickyMode: 'session',
              stickyHit: true,
              stickyBindingCount: 2,
              probability: 0,
              reason: '冷却中',
            }}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[]}
            activeTokenId={0}
            isUpdatingToken={false}
            onTokenDraftChange={vi.fn()}
            onSaveToken={vi.fn()}
            onDeleteChannel={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </SortableContext>
      </DndContext>,
    );

    const status = root.root.findByProps({ 'data-testid': 'channel-runtime-status' });
    const text = collectText(status);
    expect(text).toContain('失败 6 · 连续 2');
    expect(text).toContain('冷却至');
    expect(text).toContain('观察池 · 剩 8 请求');
    expect(text).toContain('粘黏命中 2');
  });
});
