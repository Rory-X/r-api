import {
  getDownstreamApiKeyById,
  toPolicyFromView,
  verifyDownstreamPolicySnapshotActive,
  type DownstreamPolicySnapshot,
} from './downstreamApiKeyService.js';
import { readDownstreamKeyQuotaWindows } from './downstreamKeyQuotaService.js';

export class DownstreamDispatchPolicyError extends Error {
  readonly localProxyAdmissionFailure = true;
  constructor(message: string, readonly status: number, readonly code: 'downstream_policy_changed' | 'downstream_quota_exceeded') {
    super(message); this.name = 'DownstreamDispatchPolicyError';
  }
}

/** Revalidate after queues/retries without reserving an already charged request again. */
export async function ensureDownstreamDispatchPolicy(snapshot: DownstreamPolicySnapshot): Promise<void> {
  const active = await verifyDownstreamPolicySnapshotActive(snapshot);
  if (!active.ok) throw new DownstreamDispatchPolicyError(active.error, active.statusCode, 'downstream_policy_changed');
  if (snapshot.source !== 'managed' || snapshot.keyId === null) return;
  const current = await getDownstreamApiKeyById(snapshot.keyId);
  if (!current || current.policyVersion !== snapshot.policyVersion
    || JSON.stringify(toPolicyFromView(current)) !== JSON.stringify(snapshot.policy)) {
    throw new DownstreamDispatchPolicyError('API key policy changed; start a new request', 403, 'downstream_policy_changed');
  }
  if (current.maxCost !== null && current.usedCost >= current.maxCost) {
    throw new DownstreamDispatchPolicyError('API key has exceeded max cost', 403, 'downstream_quota_exceeded');
  }
  const windows = await readDownstreamKeyQuotaWindows({ keyId: current.id });
  const exhausted = windows.find((window) => window.metric !== 'requests' && window.enforcement === 'hard' && window.remaining <= 0);
  if (exhausted) throw new DownstreamDispatchPolicyError(`API key ${exhausted.metric} quota reached`, 429, 'downstream_quota_exceeded');
}
