import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerResponseError } from './appServerControl.js';
import {
  enqueueCodexMessage,
  listQueuedCodexMessages,
  updateQueuedCodexMessage,
} from './queue.js';
import { LocalConnectorRuntime } from './runtime.js';
import type { LocalConnectorConfig } from './config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(dataDir: string): LocalConnectorConfig {
  return {
    protocol: 'metapi.local-connector.config.v1',
    serverUrl: 'http://127.0.0.1:4000',
    deviceId: 'device-a',
    connectorToken: 'lc_test',
    backupKey: Buffer.alloc(32).toString('base64url'),
    pairedAt: '2026-08-04T00:00:00.000Z',
    pollIntervalMs: 2_000,
    dataDir,
    appServerEndpoint: 'unix:/tmp/codex.sock',
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'metapi.bridge-continuation.command.v1' as const,
    taskId: 'task-a',
    leaseToken: 'bcl_abcdefghijklmnopqrstuvwxyz012345',
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    method: 'turn/start' as const,
    threadId: 'thread-a',
    prompt: '继续',
    routeAction: 'preserve' as const,
    continuationNumber: 1,
    ...overrides,
  };
}

function runtimeWithClient(client: Record<string, unknown>, dataDir: string) {
  return new LocalConnectorRuntime(
    config(dataDir),
    join(dataDir, 'config.json'),
    { executable: '/usr/bin/node', argv: ['/opt/connector.js'] },
    client as any,
  );
}

describe('local connector bridge runtime', () => {
  it('reports an accepted turn with its authoritative turn id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-bridge-'));
    roots.push(dataDir);
    const complete = vi.fn(async () => undefined);
    const runtime = runtimeWithClient({
      claimNextBridgeContinuation: vi.fn(async () => command()),
      renewBridgeContinuationLease: vi.fn(async () => true),
      completeBridgeContinuation: complete,
    }, dataDir);
    const result = await runtime.runBridgeOnce({
      continueThread: vi.fn(async () => ({ turnId: 'turn-b' })),
    } as any);
    expect(result).toEqual({ taskId: 'task-a', outcome: 'accepted' });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-a',
      outcome: 'accepted',
      turnId: 'turn-b',
    }));
  });

  it('distinguishes a known App Server rejection from an ambiguous transport failure', async () => {
    const rejectedDataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-bridge-'));
    roots.push(rejectedDataDir);
    const rejectedComplete = vi.fn(async () => undefined);
    const rejectedRuntime = runtimeWithClient({
      claimNextBridgeContinuation: vi.fn(async () => command()),
      renewBridgeContinuationLease: vi.fn(async () => true),
      completeBridgeContinuation: rejectedComplete,
    }, rejectedDataDir);
    await expect(rejectedRuntime.runBridgeOnce({
      continueThread: vi.fn(async () => {
        throw new CodexAppServerResponseError('rate limited', {
          data: {
            error: {
              message: 'rate limited',
              codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
            },
          },
        });
      }),
    } as any)).resolves.toEqual({ taskId: 'task-a', outcome: 'rejected' });
    expect(rejectedComplete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'rejected',
      failure: expect.objectContaining({ message: 'rate limited' }),
    }));

    const unknownDataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-bridge-'));
    roots.push(unknownDataDir);
    const unknownComplete = vi.fn(async () => undefined);
    const unknownRuntime = runtimeWithClient({
      claimNextBridgeContinuation: vi.fn(async () => command()),
      renewBridgeContinuationLease: vi.fn(async () => true),
      completeBridgeContinuation: unknownComplete,
    }, unknownDataDir);
    await unknownRuntime.runBridgeOnce({
      continueThread: vi.fn(async () => { throw new Error('socket closed'); }),
    } as any);
    expect(unknownComplete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'unknown',
      turnId: null,
      failure: null,
    }));
  });

  it('replays a queued Bridge result with the same delivery id after connectivity returns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-bridge-'));
    roots.push(dataDir);
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('server offline'))
      .mockResolvedValue(undefined);
    const client = {
      claimNextBridgeContinuation: vi.fn(async () => command()),
      renewBridgeContinuationLease: vi.fn(async () => true),
      completeBridgeContinuation: complete,
    };
    const runtime = runtimeWithClient(client, dataDir);

    await expect(runtime.runBridgeOnce({
      continueThread: vi.fn(async () => ({ turnId: 'turn-b' })),
    } as any)).rejects.toThrow('server offline');
    expect(await readdir(join(dataDir, 'bridge-results'))).toHaveLength(1);
    const firstDeliveryId = complete.mock.calls[0]?.[0]?.deliveryId;

    const flushed = await runtime.flushQueues();
    expect(flushed.bridgeResults).toBe(1);
    expect(complete.mock.calls[1]?.[0]?.deliveryId).toBe(firstDeliveryId);
    expect(await readdir(join(dataDir, 'bridge-results'))).toHaveLength(0);
  });

  it('re-resolves an automatic Feishu message to turn/steer when the turn is active', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-bridge-'));
    roots.push(dataDir);
    const complete = vi.fn(async () => undefined);
    const runtime = runtimeWithClient({
      claimNextBridgeContinuation: vi.fn(async () => command({ submissionMode: 'auto' })),
      renewBridgeContinuationLease: vi.fn(async () => ({
        renewed: true,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })),
      completeBridgeContinuation: complete,
    }, dataDir);
    (runtime as any).controlThreadStatuses.set('thread-a', 'active');
    (runtime as any).controlThreadActiveFlags.set('thread-a', []);
    (runtime as any).controlThreadActiveTurnIds.set('thread-a', 'turn-current');
    const continueThread = vi.fn(async () => ({ turnId: 'turn-current' }));

    await expect(runtime.runBridgeOnce({ continueThread } as any)).resolves.toEqual({
      taskId: 'task-a',
      outcome: 'accepted',
    });
    expect(continueThread).toHaveBeenCalledWith(expect.objectContaining({
      method: 'turn/steer',
      expectedTurnId: 'turn-current',
      routeAction: 'preserve',
    }));
    expect(complete.mock.calls.map(([input]) => input.outcome)).toEqual(['queued', 'accepted']);
  });

  it('keeps active-writer contention in the local queue without reporting repeated rejections', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-bridge-'));
    roots.push(dataDir);
    const complete = vi.fn(async () => undefined);
    const runtime = runtimeWithClient({
      claimNextBridgeContinuation: vi.fn(async () => command({ submissionMode: 'auto' })),
      renewBridgeContinuationLease: vi.fn(async () => ({
        renewed: true,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })),
      completeBridgeContinuation: complete,
    }, dataDir);
    (runtime as any).controlThreadStatuses.set('thread-a', 'idle');
    (runtime as any).controlThreadActiveFlags.set('thread-a', []);

    await expect(runtime.runBridgeOnce({
      continueThread: vi.fn(async () => {
        throw new CodexAppServerResponseError('active writer', {
          data: { error: { message: 'thread thread-a already has an active writer' } },
        });
      }),
    } as any)).resolves.toEqual({ taskId: 'task-a', outcome: 'queued' });
    expect(complete.mock.calls.map(([input]) => input.outcome)).toEqual(['queued']);
    await expect(listQueuedCodexMessages(dataDir)).resolves.toEqual([
      expect.objectContaining({
        phase: 'queued',
        attemptCount: 1,
        lastFailure: 'thread thread-a already has an active writer',
      }),
    ]);
  });

  it('reports a dispatching message as unknown after restart instead of duplicating it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-bridge-'));
    roots.push(dataDir);
    const queued = await enqueueCodexMessage({ dataDir, command: command() });
    await updateQueuedCodexMessage({ dataDir, item: queued, phase: 'dispatching' });
    const complete = vi.fn(async () => undefined);
    const runtime = runtimeWithClient({
      claimNextBridgeContinuation: vi.fn(async () => null),
      renewBridgeContinuationLease: vi.fn(async () => ({ renewed: true, expiresAt: queued.command.leaseExpiresAt })),
      completeBridgeContinuation: complete,
    }, dataDir);
    const continueThread = vi.fn(async () => ({ turnId: 'turn-duplicate' }));

    await expect(runtime.runBridgeOnce({ continueThread } as any)).resolves.toEqual({ taskId: null, outcome: null });
    expect(continueThread).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-a',
      outcome: 'unknown',
    }));
    await expect(listQueuedCodexMessages(dataDir)).resolves.toEqual([]);
  });
});
