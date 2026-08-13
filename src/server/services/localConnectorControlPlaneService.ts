import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { BridgeContinuationPolicyInput } from './bridgeContinuationContract.js';
import {
  createBridgeContinuationTask,
  recordBridgeThreadState,
  type BridgeContinuationTaskRecord,
} from './bridgeContinuationService.js';
import { requireActiveLocalConnectorDevice } from './localConnectorService.js';

function normalizeId(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`${label} 无效`);
  }
  return normalized;
}

function sessionKey(deviceId: string, threadId: string): string {
  const readable = `connector:${deviceId}:codex:${threadId}`;
  if (readable.length <= 256) return readable;
  const threadFingerprint = createHash('sha256').update(threadId).digest('hex');
  return `connector:${deviceId}:codex:${threadFingerprint}`;
}

function activeFlags(raw: string): BridgeContinuationTaskRecord['state']['activeFlags'] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is 'waitingOnApproval' | 'waitingOnUserInput' => (
      value === 'waitingOnApproval' || value === 'waitingOnUserInput'
    ));
  } catch {
    return [];
  }
}

export async function takeOverLocalConnectorThread(input: {
  deviceId: unknown;
  threadId: unknown;
  policy?: BridgeContinuationPolicyInput;
  creationSource?: 'single' | 'global';
}): Promise<Readonly<{
  created: boolean;
  task: BridgeContinuationTaskRecord;
}>> {
  const creationSource = input.creationSource === 'global' ? 'global' : 'single';
  const deviceId = normalizeId(input.deviceId, 'Connector 设备 ID', 128);
  const threadId = normalizeId(input.threadId, 'Codex Thread ID', 256);
  await requireActiveLocalConnectorDevice(deviceId, 'app_server.control');

  const observed = await db.select().from(schema.localConnectorThreads).where(and(
    eq(schema.localConnectorThreads.deviceId, deviceId),
    eq(schema.localConnectorThreads.threadId, threadId),
  )).get();
  if (!observed) throw new Error('Codex 会话不属于此 Connector，或尚未被本地 Connector 观测到');
  if (observed.controlState === 'external_owner') {
    throw new Error('Codex 会话当前由 Desktop App Server 持有，请等待桌面会话释放后再接管');
  }
  const result = await createBridgeContinuationTask({
    deviceId,
    threadId,
    sessionKey: sessionKey(deviceId, threadId),
    policy: input.policy,
    creationSource,
  });
  if (result.task.deviceId !== deviceId || result.task.state.threadId !== threadId) {
    throw new Error('现有 Bridge 会话与 Connector 上下文不匹配');
  }

  const observedFlags = activeFlags(observed.activeFlags);
  const stateMatches = result.task.state.threadStatus === observed.threadStatus
    && result.task.state.activeTurnId === observed.activeTurnId
    && JSON.stringify(result.task.state.activeFlags) === JSON.stringify(observedFlags);
  if (stateMatches) return result;

  const task = await recordBridgeThreadState({
    taskId: result.task.state.taskId,
    threadStatus: observed.threadStatus as BridgeContinuationTaskRecord['state']['threadStatus'],
    activeFlags: observedFlags,
    activeTurnId: observed.activeTurnId,
  });
  return Object.freeze({ created: result.created, task });
}
