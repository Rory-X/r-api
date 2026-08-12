import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
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
            onSiteBlockModel={vi.fn()}
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
            onSiteBlockModel={vi.fn()}
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
            onSiteBlockModel={vi.fn()}
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
});
