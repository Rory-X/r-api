import {
  getConfiguredNotificationChannels,
  type NotificationChannel,
  type NotificationLevel,
} from './notificationChannelDispatcher.js';
import {
  dispatchReservedNotificationOutboxRow,
  enqueueNotification,
} from './notificationOutboxService.js';

export type SendNotificationOptions = {
  bypassThrottle?: boolean;
  requireChannel?: boolean;
  throwOnFailure?: boolean;
  idempotencyKey?: string;
  channels?: NotificationChannel[];
};

export type NotificationDispatchResult = {
  notificationId: string | null;
  throttled: boolean;
  deduplicated: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  unknown: number;
  failedChannels: NotificationChannel[];
  unknownChannels: NotificationChannel[];
};

function emptyResult(input: {
  notificationId?: string | null;
  throttled?: boolean;
  deduplicated?: boolean;
} = {}): NotificationDispatchResult {
  return {
    notificationId: input.notificationId ?? null,
    throttled: input.throttled === true,
    deduplicated: input.deduplicated === true,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    failedChannels: [],
    unknownChannels: [],
  };
}

export async function sendNotification(
  title: string,
  message: string,
  level: NotificationLevel = 'info',
  options: SendNotificationOptions = {},
): Promise<NotificationDispatchResult> {
  const channels = options.channels ?? getConfiguredNotificationChannels();
  if (channels.length === 0) {
    if (options.requireChannel || options.throwOnFailure) {
      throw new Error('未启用任何通知渠道，请先开启并保存至少一种通知方式');
    }
    return emptyResult();
  }

  const enqueued = await enqueueNotification({
    title,
    message,
    level,
    bypassThrottle: options.bypassThrottle,
    idempotencyKey: options.idempotencyKey,
    channels,
    reserveForImmediateDispatch: true,
  });

  if (enqueued.throttled) {
    return emptyResult({ throttled: true });
  }
  if (enqueued.deduplicated) {
    return emptyResult({
      notificationId: enqueued.notificationId,
      deduplicated: true,
    });
  }

  const processed = await Promise.all(
    enqueued.rows.map((row) => dispatchReservedNotificationOutboxRow(row)),
  );
  const dispatches = processed.map((item) => item.dispatch ?? {
    channel: item.row.channel as NotificationChannel,
    outcome: 'failed' as const,
    error: 'notification outbox reservation was lost before immediate dispatch',
    retryAfterMs: null,
  });
  const failedDispatches = dispatches.filter((item) => item.outcome !== 'delivered');
  const unknownDispatches = dispatches.filter((item) => item.outcome === 'delivery_unknown');
  const succeeded = dispatches.length - failedDispatches.length;
  const failedChannels = failedDispatches.map((item) => item.channel);

  if (options.throwOnFailure && succeeded === 0 && failedDispatches.length > 0) {
    const details = failedDispatches
      .map((item) => `${item.channel}: ${item.error || item.outcome}`)
      .join('; ');
    throw new Error(`通知发送失败：${details}`);
  }

  return {
    notificationId: enqueued.notificationId,
    throttled: false,
    deduplicated: false,
    attempted: dispatches.length,
    succeeded,
    failed: failedDispatches.length,
    unknown: unknownDispatches.length,
    failedChannels,
    unknownChannels: unknownDispatches.map((item) => item.channel),
  };
}
