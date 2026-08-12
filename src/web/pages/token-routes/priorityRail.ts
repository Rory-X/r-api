import type { CSSProperties } from 'react';
import type { PriorityRailDragTarget, PriorityRailSection } from './types.js';
import { getPriorityTagStyle } from './utils.js';

type PriorityRailChannelLike = {
  id: number;
  priority: number;
  sortOrder?: number;
};

type BuildPriorityRailDragTargetsOptions = {
  activeChannelId: number;
  hoveredPriority: number | null;
  showNewLayerTarget: boolean;
};

export const PRIORITY_RAIL_NEW_LAYER_PREFIX = 'priority-rail:new-layer:';

export function createPriorityRailNewLayerId(priority: number): string {
  return `${PRIORITY_RAIL_NEW_LAYER_PREFIX}${priority}`;
}

export function isPriorityRailNewLayerId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PRIORITY_RAIL_NEW_LAYER_PREFIX);
}

export function parsePriorityRailNewLayerPriority(value: string): number | null {
  const raw = value.slice(PRIORITY_RAIL_NEW_LAYER_PREFIX.length);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildPriorityRailSections(
  channels: PriorityRailChannelLike[],
): PriorityRailSection[] {
  const grouped = new Map<number, number[]>();

  for (const channel of normalizePriorityRailChannels(channels || [])) {
    const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
    if (!grouped.has(priority)) grouped.set(priority, []);
    grouped.get(priority)!.push(channel.id);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([priority, channelIds]) => ({
      priority,
      channelCount: channelIds.length,
      channelIds,
    }));
}

function normalizePriorityRailChannels<T extends PriorityRailChannelLike>(channels: T[]): T[] {
  return [...(channels || [])].sort((a, b) => {
    const priorityA = Number.isFinite(a.priority) ? a.priority : 0;
    const priorityB = Number.isFinite(b.priority) ? b.priority : 0;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const orderA = Number.isFinite(a.sortOrder) ? a.sortOrder ?? 0 : 0;
    const orderB = Number.isFinite(b.sortOrder) ? b.sortOrder ?? 0 : 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.id - b.id;
  });
}

function denseScheduleChannels<T extends PriorityRailChannelLike>(
  buckets: Array<{ priority: number; channels: T[] }>,
): T[] {
  return buckets
    .filter((bucket) => bucket.channels.length > 0)
    .flatMap((bucket, priority) => bucket.channels.map((channel, sortOrder) => ({
      ...channel,
      priority,
      sortOrder,
    })));
}

export function buildPriorityRailDragTargets(
  sections: PriorityRailSection[],
  options: BuildPriorityRailDragTargetsOptions,
): PriorityRailDragTarget[] {
  const targets: PriorityRailDragTarget[] = sections.map((section) => ({
    kind: 'existing_layer',
    priority: section.priority,
    highlighted: section.priority === options.hoveredPriority,
  }));

  if (options.showNewLayerTarget) {
    const highestPriority = sections.reduce((max, section) => Math.max(max, section.priority), -1);
    targets.push({
      kind: 'new_layer',
      priority: highestPriority + 1,
      highlighted: false,
    });
  }

  return targets;
}

export function applyPriorityRailDrop<T extends PriorityRailChannelLike>(
  channels: T[],
  activeId: number,
  overId: number | string,
): T[] {
  const normalized = normalizePriorityRailChannels(channels);
  const activeChannel = normalized.find((channel) => channel.id === activeId);
  if (!activeChannel) return normalized;

  const buckets = Array.from(
    normalized.reduce((grouped, channel) => {
      const priority = Number.isFinite(channel.priority) ? channel.priority : 0;
      if (!grouped.has(priority)) grouped.set(priority, []);
      grouped.get(priority)!.push(channel);
      return grouped;
    }, new Map<number, T[]>()),
  )
    .sort((left, right) => left[0] - right[0])
    .map(([priority, bucketChannels]) => ({ priority, channels: bucketChannels }));

  const sourceBucket = buckets.find((bucket) => bucket.channels.some((channel) => channel.id === activeId));
  if (!sourceBucket) return normalized;
  sourceBucket.channels = sourceBucket.channels.filter((channel) => channel.id !== activeId);

  if (isPriorityRailNewLayerId(overId)) {
    const afterPriority = parsePriorityRailNewLayerPriority(overId);
    if (afterPriority == null) return normalized;
    const targetBucketIndex = buckets.findIndex((bucket) => bucket.priority === afterPriority);
    if (targetBucketIndex < 0 || (sourceBucket.priority === afterPriority && sourceBucket.channels.length === 0)) {
      return normalized;
    }
    buckets.splice(targetBucketIndex + 1, 0, {
      priority: afterPriority + 1,
      channels: [activeChannel],
    });
    return denseScheduleChannels(buckets);
  }

  const targetChannel = normalized.find((channel) => channel.id === Number(overId));
  if (!targetChannel || targetChannel.id === activeId) return normalized;
  const targetBucket = buckets.find((bucket) => bucket.channels.some((channel) => channel.id === targetChannel.id));
  if (!targetBucket) return normalized;
  const targetIndex = targetBucket.channels.findIndex((channel) => channel.id === targetChannel.id);
  const activeFlatIndex = normalized.findIndex((channel) => channel.id === activeId);
  const targetFlatIndex = normalized.findIndex((channel) => channel.id === targetChannel.id);
  const insertionIndex = targetIndex + (activeFlatIndex < targetFlatIndex ? 1 : 0);
  targetBucket.channels.splice(insertionIndex, 0, activeChannel);

  return denseScheduleChannels(buckets);
}

export function buildPriorityRailNodeStyle(priority: number, highlighted: boolean): CSSProperties {
  const tone = getPriorityTagStyle(priority);

  return {
    border: `1px solid ${highlighted ? 'var(--color-primary)' : 'color-mix(in srgb, currentColor 24%, transparent)'}`,
    background: highlighted
      ? `color-mix(in srgb, ${tone.background} 78%, var(--color-bg))`
      : tone.background,
    color: highlighted ? 'var(--color-primary)' : tone.color,
  };
}
