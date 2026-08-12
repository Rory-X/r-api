import type {
  BridgeRouteDirective,
  CodexTurnIdentity,
} from '../proxy-core/codexTurnMetadata.js';
import type { BridgeRouteAction } from './bridgeContinuationContract.js';
import type { BridgeContinuationTaskRecord } from './bridgeContinuationService.js';
import type {
  findLatestProxySessionRouteSelection,
  ProxySessionRouteSelection,
} from './proxyAttemptLedgerStore.js';

export type BridgeProxyRoutePlan = Readonly<{
  taskId: string;
  requestedAction: BridgeRouteAction;
  effectiveAction: BridgeRouteAction;
  continuationNumber: number;
  previousSelection: ProxySessionRouteSelection;
  reason: 'directive_applied' | 'hard_continuity_preserved';
}>;

export type BridgeProxyRouteResolution = Readonly<{
  plan: BridgeProxyRoutePlan | null;
  ignoredReason:
    | 'not_bridge_request'
    | 'non_turn_request'
    | 'task_missing'
    | 'task_terminal'
    | 'thread_mismatch'
    | 'continuation_mismatch'
    | 'route_action_mismatch'
    | 'route_history_missing'
    | null;
}>;

type RoutingDependencies = Readonly<{
  getTask: (taskId: string) => Promise<BridgeContinuationTaskRecord | null>;
  findLatestSelection: typeof findLatestProxySessionRouteSelection;
}>;

const DEFAULT_DEPENDENCIES: RoutingDependencies = Object.freeze({
  getTask: async (taskId) => (
    await import('./bridgeContinuationService.js')
  ).getBridgeContinuationTask(taskId),
  findLatestSelection: async (input) => (
    await import('./proxyAttemptLedgerStore.js')
  ).findLatestProxySessionRouteSelection(input),
});

function isTerminalTask(task: BridgeContinuationTaskRecord): boolean {
  return task.state.status === 'stopped'
    || task.state.status === 'superseded'
    || task.state.status === 'dead';
}

function continuationMatches(task: BridgeContinuationTaskRecord, continuationNumber: number): boolean {
  const current = task.state.continuationCount;
  return continuationNumber === current || continuationNumber === current + 1;
}

export async function resolveBridgeProxyRoutePlan(input: {
  directive: BridgeRouteDirective | null;
  identity: CodexTurnIdentity;
  downstreamApiKeyId?: number | null;
  hardContinuity?: boolean;
}, dependencies: RoutingDependencies = DEFAULT_DEPENDENCIES): Promise<BridgeProxyRouteResolution> {
  if (!input.directive) {
    return Object.freeze({ plan: null, ignoredReason: 'not_bridge_request' });
  }
  if (input.identity.requestKind && input.identity.requestKind !== 'turn') {
    return Object.freeze({ plan: null, ignoredReason: 'non_turn_request' });
  }

  const task = await dependencies.getTask(input.directive.taskId);
  if (!task) return Object.freeze({ plan: null, ignoredReason: 'task_missing' });
  if (isTerminalTask(task)) return Object.freeze({ plan: null, ignoredReason: 'task_terminal' });
  if (!input.identity.threadId || task.state.threadId !== input.identity.threadId) {
    return Object.freeze({ plan: null, ignoredReason: 'thread_mismatch' });
  }
  if (!continuationMatches(task, input.directive.continuationNumber)) {
    return Object.freeze({ plan: null, ignoredReason: 'continuation_mismatch' });
  }
  if (
    task.state.pendingRouteAction
    && task.state.pendingRouteAction !== input.directive.routeAction
  ) {
    return Object.freeze({ plan: null, ignoredReason: 'route_action_mismatch' });
  }

  const previousSelection = await dependencies.findLatestSelection({
    clientThreadId: input.identity.threadId,
    sessionId: input.identity.sessionId,
    downstreamApiKeyId: input.downstreamApiKeyId ?? null,
  });
  if (!previousSelection) {
    return Object.freeze({ plan: null, ignoredReason: 'route_history_missing' });
  }

  const effectiveAction = input.hardContinuity
    ? 'preserve'
    : input.directive.routeAction;
  return Object.freeze({
    plan: Object.freeze({
      taskId: input.directive.taskId,
      requestedAction: input.directive.routeAction,
      effectiveAction,
      continuationNumber: input.directive.continuationNumber,
      previousSelection,
      reason: input.hardContinuity && input.directive.routeAction !== 'preserve'
        ? 'hard_continuity_preserved'
        : 'directive_applied',
    }),
    ignoredReason: null,
  });
}
