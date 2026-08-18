import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueBridgeAppServerEvent,
  enqueueBridgeContinuationResult,
  enqueueCodexMessage,
  enqueueLocalConnectorEvent,
  enqueueLocalConnectorResult,
  flushLocalConnectorQueues,
  listQueuedCodexMessages,
  removeQueuedCodexMessage,
  updateQueuedCodexMessage,
} from './queue.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local connector durable queues', () => {
  it('keeps failed deliveries and flushes results before events', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-connector-queue-'));
    roots.push(dataDir);
    await enqueueLocalConnectorEvent({ dataDir, kind: 'notify', title: 'done', message: 'ok' });
    await enqueueLocalConnectorResult(dataDir, {
      actionId: 'action-1',
      status: 'succeeded',
      result: { changed: true },
      backupRef: 'lcb_test',
      errorMessage: null,
    });
    const calls: string[] = [];
    const sendResult = vi.fn(async () => {
      calls.push('result');
      throw new Error('offline');
    });
    const sendEvent = vi.fn(async () => { calls.push('event'); });
    await expect(flushLocalConnectorQueues({ dataDir, sendResult, sendEvent })).rejects.toThrow('offline');
    expect(calls).toEqual(['result']);
    expect(await readdir(join(dataDir, 'results'))).toHaveLength(1);

    sendResult.mockImplementation(async () => { calls.push('result-retry'); });
    const flushed = await flushLocalConnectorQueues({ dataDir, sendResult, sendEvent });
    expect(flushed).toEqual({ results: 1, events: 1, bridgeResults: 0, bridgeEvents: 0 });
    expect(calls).toEqual(['result', 'result-retry', 'event']);
  });

  it('rejects an action id that could escape the queue directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-connector-queue-'));
    roots.push(dataDir);
    await expect(enqueueLocalConnectorResult(dataDir, {
      actionId: '../../escape',
      status: 'failed',
      result: null,
      backupRef: null,
      errorMessage: 'invalid',
    })).rejects.toThrow('actionId');
  });

  it('keeps Bridge delivery ids stable across failed result and event replay', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-connector-queue-'));
    roots.push(dataDir);
    const result = await enqueueBridgeContinuationResult({
      dataDir,
      taskId: 'task-a',
      leaseToken: 'bcl_abcdefghijklmnopqrstuvwxyz012345',
      outcome: 'accepted',
      turnId: 'turn-b',
    });
    const event = await enqueueBridgeAppServerEvent({
      dataDir,
      taskId: 'task-a',
      event: { kind: 'turn_started', threadId: 'thread-a', turnId: 'turn-b' },
    });
    const deliveredIds: string[] = [];
    const sendBridgeResult = vi.fn(async (item: typeof result) => {
      deliveredIds.push(item.deliveryId);
      throw new Error('offline');
    });
    const sendBridgeEvent = vi.fn(async (item: typeof event) => {
      deliveredIds.push(item.deliveryId);
    });
    const noop = vi.fn(async () => undefined);

    await expect(flushLocalConnectorQueues({
      dataDir,
      sendResult: noop,
      sendEvent: noop,
      sendBridgeResult,
      sendBridgeEvent,
    })).rejects.toThrow('offline');
    expect(deliveredIds).toEqual([result.deliveryId]);
    expect(await readdir(join(dataDir, 'bridge-results'))).toHaveLength(1);

    sendBridgeResult.mockImplementation(async (item) => { deliveredIds.push(item.deliveryId); });
    const flushed = await flushLocalConnectorQueues({
      dataDir,
      sendResult: noop,
      sendEvent: noop,
      sendBridgeResult,
      sendBridgeEvent,
    });
    expect(flushed).toEqual({ results: 0, events: 0, bridgeResults: 1, bridgeEvents: 1 });
    expect(deliveredIds).toEqual([result.deliveryId, result.deliveryId, event.deliveryId]);
  });

  it('persists one Codex message per Bridge task across retries and restart recovery', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-connector-queue-'));
    roots.push(dataDir);
    const item = await enqueueCodexMessage({
      dataDir,
      now: new Date('2026-08-14T09:00:00.000Z'),
      command: {
        protocol: 'metapi.bridge-continuation.command.v1',
        taskId: 'task-message-a',
        leaseToken: 'bcl_abcdefghijklmnopqrstuvwxyz012345',
        leaseExpiresAt: '2026-08-14T09:00:30.000Z',
        method: 'turn/start',
        threadId: 'thread-a',
        prompt: '继续排查',
        routeAction: 'preserve',
        continuationNumber: 1,
        submissionMode: 'auto',
      },
    });
    await updateQueuedCodexMessage({
      dataDir,
      item,
      phase: 'dispatching',
      attemptCount: 1,
      nextAttemptAt: '2026-08-14T09:00:01.000Z',
      lastFailure: 'active writer',
    });

    await expect(listQueuedCodexMessages(dataDir)).resolves.toEqual([
      expect.objectContaining({
        phase: 'dispatching',
        attemptCount: 1,
        lastFailure: 'active writer',
        command: expect.objectContaining({ taskId: 'task-message-a', submissionMode: 'auto' }),
      }),
    ]);
    await removeQueuedCodexMessage(dataDir, 'task-message-a');
    await expect(listQueuedCodexMessages(dataDir)).resolves.toEqual([]);
  });
});
