export const LOCAL_CONNECTOR_SCOPES = [
  'hooks.manage',
  'hooks.emit',
  'notify.manage',
  'notify.emit',
  'browser.recovery',
  'app_server.observe',
  'app_server.control',
] as const;
export type LocalConnectorScope = typeof LOCAL_CONNECTOR_SCOPES[number];

export const LOCAL_CONNECTOR_ACTION_KINDS = ['hook', 'notify'] as const;
export type LocalConnectorActionKind = typeof LOCAL_CONNECTOR_ACTION_KINDS[number];

export const LOCAL_CONNECTOR_ACTION_OPERATIONS = ['install', 'backup', 'rollback', 'uninstall'] as const;
export type LocalConnectorActionOperation = typeof LOCAL_CONNECTOR_ACTION_OPERATIONS[number];

export const LOCAL_CONNECTOR_ACTION_STATUSES = [
  'pending',
  'claimed',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;
export type LocalConnectorActionStatus = typeof LOCAL_CONNECTOR_ACTION_STATUSES[number];

export type LocalConnectorEventKind = 'hook' | 'notify' | 'app_server' | 'browser_recovery';

export const LOCAL_CONNECTOR_HEALTH_CHECK_IDS = ['codex_notify'] as const;
export type LocalConnectorHealthCheckId = typeof LOCAL_CONNECTOR_HEALTH_CHECK_IDS[number];

export const LOCAL_CONNECTOR_HEALTH_STATUSES = ['healthy', 'unavailable'] as const;
export type LocalConnectorHealthStatus = typeof LOCAL_CONNECTOR_HEALTH_STATUSES[number];

export const LOCAL_CONNECTOR_HEALTH_REASONS = [
  'config_missing',
  'config_invalid',
  'managed_wrapper_missing',
  'managed_command_mismatch',
  'forward_notify_invalid',
  'runtime_missing',
] as const;
export type LocalConnectorHealthReason = typeof LOCAL_CONNECTOR_HEALTH_REASONS[number];

export type LocalConnectorHealthReportWire = Readonly<{
  checkId: LocalConnectorHealthCheckId;
  status: LocalConnectorHealthStatus;
  reason: LocalConnectorHealthReason | null;
  observedAt: string;
}>;

export type LocalConnectorThreadSnapshotSource = 'connector_app_server' | 'codex_desktop';

export type LocalConnectorThreadSnapshotWire = Readonly<{
  threadId: string;
  title?: string | null;
  status: 'loaded' | 'unknown' | 'not_loaded' | 'idle' | 'active' | 'system_error';
  activeFlags?: readonly ('waitingOnApproval' | 'waitingOnUserInput')[];
  activeTurnId?: string | null;
  updatedAt?: string | null;
}>;
export type LocalConnectorAgent = 'codex' | 'claude_code';

export type BridgeContinuationCommandWire = {
  protocol: 'metapi.bridge-continuation.command.v1';
  taskId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  method: 'turn/start' | 'turn/steer';
  threadId: string;
  expectedTurnId?: string;
  prompt: string;
  routeAction: 'preserve' | 'rotate_credential' | 'switch_channel';
  continuationNumber: number;
  submissionMode?: 'auto' | 'steer_current' | 'start_next' | null;
};

export type BridgeAppServerEventWire =
  | {
    kind: 'thread_status';
    threadId: string;
    status: 'unknown' | 'not_loaded' | 'idle' | 'active' | 'system_error';
    activeFlags: readonly ('waitingOnApproval' | 'waitingOnUserInput')[];
  }
  | { kind: 'turn_started'; threadId: string; turnId: string }
  | {
    kind: 'turn_completed';
    threadId: string;
    turnId: string;
    status: 'completed' | 'interrupted' | 'failed';
    failure: Record<string, unknown> | null;
  }
  | {
    kind: 'error';
    threadId: string;
    turnId: string;
    failure: Record<string, unknown>;
  };

export type LocalConnectorActionManifest = {
  protocol: 'metapi.local-connector.action.v1';
  actionId: string;
  kind: LocalConnectorActionKind;
  operation: LocalConnectorActionOperation;
  agent: LocalConnectorAgent;
  requiresBackup: boolean;
  backupRef: string | null;
  eventNames: string[];
  endpoints: {
    events: '/api/local-connector/public/events';
    browserRecoveryClaim: '/api/browser-credential-tasks/public/claim';
    browserRecoveryComplete: '/api/browser-credential-tasks/public/complete';
  };
  createdAt: string;
};

export type LocalConnectorActionWire = {
  id: string;
  deviceId: string;
  kind: LocalConnectorActionKind;
  operation: LocalConnectorActionOperation;
  status: LocalConnectorActionStatus;
  manifest: LocalConnectorActionManifest;
  backupRef?: string | null;
  expiresAt: string;
  createdAt?: string | null;
};

export function isLocalConnectorActionManifest(value: unknown): value is LocalConnectorActionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  const endpoints = manifest.endpoints as Record<string, unknown> | undefined;
  return manifest.protocol === 'metapi.local-connector.action.v1'
    && typeof manifest.actionId === 'string'
    && /^[a-zA-Z0-9._:-]{1,128}$/.test(manifest.actionId)
    && (LOCAL_CONNECTOR_ACTION_KINDS as readonly unknown[]).includes(manifest.kind)
    && (LOCAL_CONNECTOR_ACTION_OPERATIONS as readonly unknown[]).includes(manifest.operation)
    && (manifest.agent === 'codex' || manifest.agent === 'claude_code')
    && typeof manifest.requiresBackup === 'boolean'
    && (manifest.backupRef === null || (typeof manifest.backupRef === 'string' && manifest.backupRef.length <= 512))
    && Array.isArray(manifest.eventNames)
    && manifest.eventNames.length <= 32
    && manifest.eventNames.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 80)
    && Boolean(endpoints && !Array.isArray(endpoints))
    && endpoints?.events === '/api/local-connector/public/events'
    && endpoints?.browserRecoveryClaim === '/api/browser-credential-tasks/public/claim'
    && endpoints?.browserRecoveryComplete === '/api/browser-credential-tasks/public/complete'
    && typeof manifest.createdAt === 'string'
    && manifest.createdAt.length <= 80;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,256}$/.test(value);
}

function normalizeBridgeFailureWire(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const source = value.source === 'error_notification'
    || value.source === 'turn_completed'
    || value.source === 'control_error'
    || value.source === 'gateway_observation'
    ? value.source
    : undefined;
  const message = typeof value.message === 'string'
    ? value.message.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 2_000)
    : undefined;
  const status = Math.trunc(Number(value.httpStatusCode));
  const httpStatusCode = Number.isInteger(status) && status >= 100 && status <= 999 ? status : undefined;
  const willRetry = typeof value.willRetry === 'boolean' ? value.willRetry : undefined;
  let codexErrorInfo: unknown;
  if (typeof value.codexErrorInfo === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(value.codexErrorInfo)) {
    codexErrorInfo = value.codexErrorInfo;
  } else if (isRecord(value.codexErrorInfo)) {
    const allowedObjectKeys = [
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
      'responseTooManyFailedAttempts',
      'activeTurnNotSteerable',
    ];
    const key = allowedObjectKeys.find((candidate) => candidate in (value.codexErrorInfo as Record<string, unknown>));
    if (key) {
      const details = isRecord(value.codexErrorInfo[key]) ? value.codexErrorInfo[key] as Record<string, unknown> : {};
      if (key === 'activeTurnNotSteerable') {
        const turnKind = details.turnKind === 'review' || details.turnKind === 'compact' ? details.turnKind : 'review';
        codexErrorInfo = { [key]: { turnKind } };
      } else {
        const nestedStatus = Math.trunc(Number(details.httpStatusCode));
        codexErrorInfo = {
          [key]: {
            httpStatusCode: Number.isInteger(nestedStatus) && nestedStatus >= 100 && nestedStatus <= 999
              ? nestedStatus
              : null,
          },
        };
      }
    }
  }
  return {
    ...(source ? { source } : {}),
    ...(message ? { message } : {}),
    ...(httpStatusCode ? { httpStatusCode } : {}),
    ...(willRetry !== undefined ? { willRetry } : {}),
    ...(codexErrorInfo ? { codexErrorInfo } : {}),
  };
}

export function isBridgeContinuationCommandWire(value: unknown): value is BridgeContinuationCommandWire {
  if (!isRecord(value)) return false;
  return value.protocol === 'metapi.bridge-continuation.command.v1'
    && isSafeId(value.taskId)
    && typeof value.leaseToken === 'string'
    && /^bcl_[a-zA-Z0-9_-]{20,256}$/.test(value.leaseToken)
    && typeof value.leaseExpiresAt === 'string'
    && Number.isFinite(Date.parse(value.leaseExpiresAt))
    && (value.method === 'turn/start' || value.method === 'turn/steer')
    && isSafeId(value.threadId)
    && (value.method === 'turn/start' || isSafeId(value.expectedTurnId))
    && (value.method !== 'turn/steer' || value.routeAction === 'preserve')
    && typeof value.prompt === 'string'
    && value.prompt.trim().length > 0
    && value.prompt.length <= 4_000
    && (value.routeAction === 'preserve' || value.routeAction === 'rotate_credential' || value.routeAction === 'switch_channel')
    && Number.isInteger(value.continuationNumber)
    && Number(value.continuationNumber) > 0
    && (value.submissionMode === undefined
      || value.submissionMode === null
      || value.submissionMode === 'auto'
      || value.submissionMode === 'steer_current'
      || value.submissionMode === 'start_next');
}

export function normalizeBridgeAppServerEventWire(value: unknown): BridgeAppServerEventWire | null {
  if (!isRecord(value) || !isSafeId(value.threadId) || typeof value.kind !== 'string') return null;
  if (value.kind === 'thread_status') {
    const allowedStatuses = new Set(['unknown', 'not_loaded', 'idle', 'active', 'system_error']);
    if (!allowedStatuses.has(String(value.status))) return null;
    const flags = Array.isArray(value.activeFlags)
      ? [...new Set(value.activeFlags.filter(
        (item): item is 'waitingOnApproval' | 'waitingOnUserInput' => (
          item === 'waitingOnApproval' || item === 'waitingOnUserInput'
        ),
      ))]
      : [];
    const status = String(value.status) as 'unknown' | 'not_loaded' | 'idle' | 'active' | 'system_error';
    return {
      kind: 'thread_status',
      threadId: value.threadId,
      status,
      activeFlags: flags,
    };
  }
  if (!isSafeId(value.turnId)) return null;
  if (value.kind === 'turn_started') {
    return { kind: 'turn_started', threadId: value.threadId, turnId: value.turnId };
  }
  if (value.kind === 'turn_completed') {
    if (value.status !== 'completed' && value.status !== 'interrupted' && value.status !== 'failed') return null;
    return {
      kind: 'turn_completed',
      threadId: value.threadId,
      turnId: value.turnId,
      status: value.status,
      failure: normalizeBridgeFailureWire(value.failure),
    };
  }
  if (value.kind === 'error') {
    const failure = normalizeBridgeFailureWire(value.failure);
    return failure ? { kind: 'error', threadId: value.threadId, turnId: value.turnId, failure } : null;
  }
  return null;
}
