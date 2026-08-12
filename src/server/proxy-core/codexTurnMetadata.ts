import type { BridgeRouteAction } from '../services/bridgeContinuationContract.js';

export const CODEX_TURN_METADATA_KEY = 'x-codex-turn-metadata';

const BRIDGE_ROUTE_ACTIONS = new Set<BridgeRouteAction>([
  'preserve',
  'rotate_credential',
  'switch_channel',
]);

export type CodexTurnIdentity = Readonly<{
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  requestKind: string | null;
}>;

export type BridgeRouteDirective = Readonly<{
  taskId: string;
  routeAction: BridgeRouteAction;
  continuationNumber: number;
}>;

export type ParsedCodexTurnMetadata = Readonly<{
  identity: CodexTurnIdentity;
  bridgeRouteDirective: BridgeRouteDirective | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asBoundedString(value: unknown, maxLength = 256): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) return null;
  return normalized;
}

function readHeaderValue(headers: Record<string, unknown> | undefined, targetKey: string): string | null {
  if (!headers) return null;
  const normalizedTarget = targetKey.trim().toLowerCase();
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedTarget) continue;
    if (typeof rawValue === 'string') return rawValue.trim() || null;
    if (!Array.isArray(rawValue)) return null;
    for (const item of rawValue) {
      if (typeof item === 'string' && item.trim()) return item.trim();
    }
  }
  return null;
}

function parseMetadataRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readCanonicalMetadata(input: {
  body?: unknown;
  headers?: Record<string, unknown>;
}): Record<string, unknown> | null {
  if (isRecord(input.body) && isRecord(input.body.client_metadata)) {
    const canonical = parseMetadataRecord(input.body.client_metadata[CODEX_TURN_METADATA_KEY]);
    if (canonical) return canonical;

    const flatClientMetadata = input.body.client_metadata;
    if (
      asBoundedString(flatClientMetadata.session_id)
      || asBoundedString(flatClientMetadata.thread_id)
      || asBoundedString(flatClientMetadata.turn_id)
    ) {
      return flatClientMetadata;
    }
  }

  return parseMetadataRecord(readHeaderValue(input.headers, CODEX_TURN_METADATA_KEY));
}

function parseBridgeRouteDirective(metadata: Record<string, unknown>): BridgeRouteDirective | null {
  const taskId = asBoundedString(metadata.metapi_bridge_task_id);
  const routeAction = asBoundedString(metadata.metapi_bridge_route_action, 64) as BridgeRouteAction | null;
  const continuationNumber = Math.trunc(Number(metadata.metapi_bridge_continuation_number));
  if (
    !taskId
    || !routeAction
    || !BRIDGE_ROUTE_ACTIONS.has(routeAction)
    || !Number.isSafeInteger(continuationNumber)
    || continuationNumber <= 0
    || continuationNumber > 10_000
  ) {
    return null;
  }
  return Object.freeze({ taskId, routeAction, continuationNumber });
}

export function parseCodexTurnMetadata(input: {
  body?: unknown;
  headers?: Record<string, unknown>;
}): ParsedCodexTurnMetadata | null {
  const metadata = readCanonicalMetadata(input);
  if (!metadata) return null;

  return Object.freeze({
    identity: Object.freeze({
      sessionId: asBoundedString(metadata.session_id),
      threadId: asBoundedString(metadata.thread_id),
      turnId: asBoundedString(metadata.turn_id),
      requestKind: asBoundedString(metadata.request_kind, 64),
    }),
    bridgeRouteDirective: parseBridgeRouteDirective(metadata),
  });
}
