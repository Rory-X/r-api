import { describe, expect, it } from 'vitest';
import {
  createInteractionRequestState,
  transitionInteractionRequest,
} from './interactionRequestState.js';

function pending() {
  return createInteractionRequestState({
    requestId: 'interaction-a',
    sourceRequestKey: 'source-key-a',
    kind: 'command_approval',
    method: 'item/commandExecution/requestApproval',
    deviceId: 'device-a',
    connectionId: 'connection-a',
    sourceRequestId: '41',
    threadId: 'thread-a',
    turnId: 'turn-a',
    itemId: 'item-a',
    nowMs: 1_000,
    expiresAtMs: 61_000,
  });
}

describe('interaction request state', () => {
  it('commits exactly one operator response and records delivery attempts', () => {
    const responded = transitionInteractionRequest(pending(), {
      type: 'operator_response',
      responsePayload: { decision: 'accept' },
      source: 'im',
      operatorId: 'operator-a',
      idempotencyKeyHash: 'hash-a',
      nowMs: 2_000,
    });
    expect(responded).toMatchObject({
      status: 'response_pending',
      reason: 'response_committed',
      responseSource: 'im',
      responseOperatorId: 'operator-a',
      responseDeliveryCount: 0,
    });

    const delivered = transitionInteractionRequest(responded, {
      type: 'response_delivered',
      nowMs: 3_000,
    });
    expect(delivered).toMatchObject({ responseDeliveryCount: 1, responseDeliveredAtMs: 3_000 });
    expect(() => transitionInteractionRequest(delivered, {
      type: 'operator_response',
      responsePayload: { decision: 'decline' },
      source: 'webui',
      operatorId: 'operator-b',
      idempotencyKeyHash: 'hash-b',
      nowMs: 4_000,
    })).toThrow('already has a response');
  });

  it('uses source resolution as the authoritative terminal acknowledgement', () => {
    const responded = transitionInteractionRequest(pending(), {
      type: 'operator_response',
      responsePayload: { decision: 'acceptForSession' },
      source: 'webui',
      operatorId: 'admin',
      idempotencyKeyHash: 'hash-a',
      nowMs: 2_000,
    });
    expect(transitionInteractionRequest(responded, {
      type: 'source_resolved',
      nowMs: 3_000,
    })).toMatchObject({ status: 'resolved', reason: 'source_resolved', resolvedAtMs: 3_000 });
  });

  it('marks a request cleared before any response as cancelled', () => {
    expect(transitionInteractionRequest(pending(), {
      type: 'source_resolved',
      nowMs: 2_000,
    })).toMatchObject({ status: 'cancelled', reason: 'source_cleared' });
  });

  it('expires pending and undelivered responses at the absolute deadline', () => {
    expect(transitionInteractionRequest(pending(), {
      type: 'operator_response',
      responsePayload: { decision: 'accept' },
      source: 'webui',
      operatorId: 'admin',
      idempotencyKeyHash: 'hash-a',
      nowMs: 61_000,
    })).toMatchObject({ status: 'expired', reason: 'expired' });

    const responded = transitionInteractionRequest(pending(), {
      type: 'operator_response',
      responsePayload: { decision: 'accept' },
      source: 'webui',
      operatorId: 'admin',
      idempotencyKeyHash: 'hash-a',
      nowMs: 2_000,
    });
    expect(transitionInteractionRequest(responded, { type: 'expire', nowMs: 61_000 }))
      .toMatchObject({ status: 'expired', reason: 'expired' });
  });

  it('lets device revocation cancel an unresolved request and keeps terminal states stable', () => {
    const cancelled = transitionInteractionRequest(pending(), {
      type: 'device_revoked',
      nowMs: 2_000,
    });
    expect(cancelled).toMatchObject({ status: 'cancelled', reason: 'device_revoked' });
    expect(transitionInteractionRequest(cancelled, { type: 'source_resolved', nowMs: 3_000 })).toBe(cancelled);
  });
});
