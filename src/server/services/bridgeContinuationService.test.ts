import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./bridgeContinuationService.js');

describe('bridge continuation service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-bridge-continuation-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./bridgeContinuationService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorDevices).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  function policy() {
    return {
      enabled: true,
      continuePrompt: '继续',
      backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000, multiplier: 2, jitterRatio: 0 },
      rules: {
        rate_limited: { action: 'continue_same_route', limit: 'unlimited' },
        retry_exhausted: { action: 'continue_rotate_credential', maxContinuations: 3 },
      },
    } as const;
  }

  async function createTask(sessionKey = 'device-a:thread-a', now = 1_000) {
    return service.createBridgeContinuationTask({
      sessionKey,
      threadId: sessionKey.split(':').at(-1) || 'thread-a',
      policy: policy(),
      now,
    });
  }

  async function scheduleRateLimitedTask(now = 2_000) {
    const created = await createTask('device-a:thread-a', 1_000);
    const scheduled = await service.recordBridgeContinuationFailure({
      taskId: created.task.state.taskId,
      failure: {
        source: 'turn_completed',
        httpStatusCode: 429,
        willRetry: false,
      },
      threadStatus: 'idle',
      turnTerminal: true,
      jitterUnit: 0.5,
      now,
    });
    return { created, scheduled };
  }

  it('keeps one active task per session while retaining terminal history', async () => {
    const first = await createTask();
    const duplicate = await createTask('device-a:thread-a', 1_100);
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      task: { state: { taskId: first.task.state.taskId } },
    });

    const stopped = await service.stopBridgeContinuationTask(first.task.state.taskId, 2_000);
    expect(stopped.state).toMatchObject({ status: 'stopped', reason: 'manual_stop' });

    const replacement = await createTask('device-a:thread-a', 3_000);
    expect(replacement.created).toBe(true);
    expect(replacement.task.state.taskId).not.toBe(first.task.state.taskId);
    const rows = await service.listBridgeContinuationTasks({ sessionKey: 'device-a:thread-a' });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => ['waiting', 'backoff', 'running'].includes(row.state.status))).toHaveLength(1);
  });

  it('waits for Codex final failure, then claims and completes one leased continuation', async () => {
    const created = await createTask();
    const taskId = created.task.state.taskId;
    let task = await service.recordBridgeContinuationFailure({
      taskId,
      failure: { source: 'error_notification', httpStatusCode: 429, willRetry: true },
      threadStatus: 'active',
      now: 2_000,
    });
    expect(task.state).toMatchObject({ status: 'waiting', reason: 'codex_internal_retry' });

    task = await service.recordBridgeContinuationFailure({
      taskId,
      failure: { source: 'error_notification', httpStatusCode: 429, willRetry: false },
      threadStatus: 'active',
      retryAfterMs: 5_000,
      now: 3_000,
    });
    expect(task.state).toMatchObject({ status: 'waiting', reason: 'thread_active' });

    task = await service.recordBridgeThreadState({ taskId, threadStatus: 'idle', now: 4_000 });
    expect(task.state).toMatchObject({ status: 'backoff', nextRunAtMs: 9_000 });
    await expect(service.claimNextBridgeContinuationTask({ ownerId: 'worker-a', now: 8_999 })).resolves.toBeNull();

    const claim = await service.claimNextBridgeContinuationTask({
      ownerId: 'worker-a',
      leaseTtlMs: 10_000,
      now: 9_000,
    });
    expect(claim).toMatchObject({
      task: { state: { status: 'running', continuationCount: 0 } },
      command: {
        method: 'turn/start',
        threadId: 'thread-a',
        prompt: '继续',
        routeAction: 'preserve',
        continuationNumber: 1,
      },
    });
    expect(claim?.leaseToken).toMatch(/^bcl_/);
    const storedLease = await db.select().from(schema.bridgeContinuationLeases).get();
    expect(storedLease?.leaseTokenHash).not.toContain(claim?.leaseToken || 'missing');
    await expect(service.claimNextBridgeContinuationTask({ ownerId: 'worker-b', now: 9_100 })).resolves.toBeNull();
    if (!claim) return;

    await expect(service.renewBridgeContinuationTaskLease({
      taskId,
      leaseToken: claim.leaseToken,
      leaseTtlMs: 10_000,
      now: 9_500,
    })).resolves.toMatchObject({ renewed: true, expiresAt: '1970-01-01T00:00:19.500Z' });

    const dispatched = await service.completeBridgeContinuationDispatch({
      taskId,
      leaseToken: claim.leaseToken,
      outcome: 'accepted',
      turnId: 'turn-b',
      now: 9_600,
    });
    expect(dispatched).toMatchObject({
      updated: true,
      reason: 'accepted',
      task: { state: { status: 'waiting', reason: 'turn_active', continuationCount: 1, activeTurnId: 'turn-b' } },
    });
    expect(await db.select().from(schema.bridgeContinuationLeases).all()).toHaveLength(0);

    const completed = await service.recordBridgeTurnCompleted({
      taskId,
      turnId: 'turn-b',
      status: 'completed',
      now: 10_000,
    });
    expect(completed.state).toMatchObject({ status: 'stopped', reason: 'turn_completed' });
  });

  it('marks an expired running lease as an ambiguous dispatch instead of replaying it', async () => {
    const { created } = await scheduleRateLimitedTask();
    const taskId = created.task.state.taskId;
    const claim = await service.claimNextBridgeContinuationTask({
      ownerId: 'worker-a',
      leaseTtlMs: 1_000,
      now: 3_000,
    });
    expect(claim?.task.state.status).toBe('running');

    await expect(service.recoverExpiredBridgeContinuationLeases(4_000)).resolves.toBe(1);
    let task = await service.getBridgeContinuationTask(taskId);
    expect(task?.state).toMatchObject({
      status: 'waiting',
      reason: 'dispatch_outcome_unknown',
      continuationCount: 0,
      nextRunAtMs: null,
    });
    expect(task?.lease).toBeNull();
    await expect(service.claimNextBridgeContinuationTask({ ownerId: 'worker-b', now: 20_000 })).resolves.toBeNull();

    task = await service.recordBridgeThreadState({ taskId, threadStatus: 'idle', now: 21_000 });
    expect(task.state).toMatchObject({ status: 'waiting', reason: 'dispatch_outcome_unknown' });
  });

  it('lets a manual prompt supersede automation and records safe audit metadata', async () => {
    const { created, scheduled } = await scheduleRateLimitedTask();
    expect(scheduled.state.status).toBe('backoff');
    const superseded = await service.supersedeBridgeContinuationTask(created.task.state.taskId, 2_100);
    expect(superseded.state).toMatchObject({ status: 'superseded', reason: 'manual_prompt' });

    const unchanged = await service.recordBridgeContinuationFailure({
      taskId: created.task.state.taskId,
      failure: { httpStatusCode: 429, message: 'secret-ish upstream detail', willRetry: false },
      threadStatus: 'idle',
      now: 3_000,
    });
    expect(unchanged.state.status).toBe('superseded');

    const events = await service.listBridgeContinuationEvents(created.task.state.taskId);
    expect(events.map((event) => event.eventType)).toEqual([
      'manual_prompt',
      'failure_observed',
      'task_created',
    ]);
    expect(events.map((event) => event.metadata || '').join('\n')).not.toContain('secret-ish upstream detail');
  });

  it('stops active tasks when their paired connector device is revoked', async () => {
    await db.insert(schema.localConnectorDevices).values({
      id: 'device-a',
      name: 'MacBook',
      platform: 'macos',
      status: 'active',
      tokenHash: 'hash-device-a',
      scopes: '["app_server.control"]',
      pairedAt: '1970-01-01T00:00:01.000Z',
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z',
    }).run();
    const created = await service.createBridgeContinuationTask({
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      deviceId: 'device-a',
      policy: policy(),
      now: 1_000,
    });
    await expect(service.stopBridgeContinuationTasksForDevice('device-a', 2_000)).resolves.toBe(1);
    const task = await service.getBridgeContinuationTask(created.task.state.taskId);
    expect(task?.state).toMatchObject({ status: 'stopped', reason: 'device_revoked' });
  });

  it('turns a manual prompt into the single active leased steer command', async () => {
    const created = await createTask('device-a:thread-a', 1_000);
    await service.recordBridgeThreadState({
      taskId: created.task.state.taskId,
      threadStatus: 'active',
      activeFlags: [],
      activeTurnId: 'turn-a',
      now: 2_000,
    });
    const manual = await service.createManualBridgePromptTask({
      contextTaskId: created.task.state.taskId,
      prompt: '先处理失败测试',
      submissionMode: 'auto',
      source: 'im',
      operatorId: 'feishu:open_id:ou_allowed',
      sourceAdapterId: 'adapter-a',
      idempotencyKey: 'ticket-a',
      now: 3_000,
    });
    expect(manual).toMatchObject({
      created: true,
      deduplicated: false,
      supersededTaskId: created.task.state.taskId,
      task: {
        state: {
          taskKind: 'manual_prompt',
          status: 'backoff',
          pendingMethod: 'turn/steer',
          activeTurnId: 'turn-a',
        },
        requestSource: 'im',
        requestedBy: 'feishu:open_id:ou_allowed',
        sourceAdapterId: 'adapter-a',
      },
    });
    const original = await service.getBridgeContinuationTask(created.task.state.taskId);
    expect(original?.state).toMatchObject({ status: 'superseded', reason: 'manual_prompt' });

    const replayed = await service.createManualBridgePromptTask({
      contextTaskId: created.task.state.taskId,
      prompt: '先处理失败测试',
      submissionMode: 'auto',
      source: 'im',
      operatorId: 'feishu:open_id:ou_allowed',
      sourceAdapterId: 'adapter-a',
      idempotencyKey: 'ticket-a',
      now: 3_100,
    });
    expect(replayed).toMatchObject({
      created: false,
      deduplicated: true,
      task: { state: { taskId: manual.task.state.taskId } },
    });
    await expect(service.createManualBridgePromptTask({
      contextTaskId: created.task.state.taskId,
      prompt: '同一幂等键下的不同内容',
      submissionMode: 'auto',
      source: 'im',
      operatorId: 'feishu:open_id:ou_allowed',
      sourceAdapterId: 'adapter-a',
      idempotencyKey: 'ticket-a',
      now: 3_200,
    })).rejects.toThrow('人工 Prompt 幂等键已用于不同请求');

    const claim = await service.claimNextBridgeContinuationTask({ ownerId: 'worker-a', now: 3_000 });
    expect(claim).toMatchObject({
      task: { state: { taskId: manual.task.state.taskId, status: 'running' } },
      command: {
        method: 'turn/steer',
        expectedTurnId: 'turn-a',
        prompt: '先处理失败测试',
        routeAction: 'preserve',
      },
    });
    if (!claim) return;
    await service.completeBridgeContinuationDispatch({
      taskId: manual.task.state.taskId,
      leaseToken: claim.leaseToken,
      outcome: 'accepted',
      turnId: 'turn-a',
      now: 3_100,
    });
    const stored = await service.getBridgeContinuationTask(manual.task.state.taskId);
    expect(stored?.state).toMatchObject({
      status: 'waiting',
      reason: 'turn_active',
      pendingPrompt: null,
      pendingMethod: null,
    });
    expect(stored?.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const events = await service.listBridgeContinuationEvents(manual.task.state.taskId);
    expect(events.map((event) => event.metadata || '').join('\n')).not.toContain('先处理失败测试');
  });

  it('keeps an active-writer rejection queued and dispatches the Prompt exactly once later', async () => {
    await db.insert(schema.localConnectorDevices).values({
      id: 'device-writer-contention',
      name: 'Desktop Mac',
      platform: 'macos',
      status: 'active',
      tokenHash: 'hash-device-writer-contention',
      scopes: '["app_server.control"]',
      pairedAt: '1970-01-01T00:00:01.000Z',
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z',
    }).run();
    const manual = await service.createManualBridgePromptTask({
      deviceId: 'device-writer-contention',
      threadId: 'thread-writer-contention',
      threadStatus: 'idle',
      prompt: '当前会话结束后继续',
      submissionMode: 'start_next',
      source: 'im',
      operatorId: 'feishu:open_id:ou_allowed',
      sourceAdapterId: 'adapter-a',
      idempotencyKey: 'writer-contention-prompt',
      now: 2_000,
    });
    const firstClaim = await service.claimNextBridgeContinuationTask({
      ownerId: 'connector:device-writer-contention',
      deviceId: 'device-writer-contention',
      now: 2_000,
    });
    expect(firstClaim?.command).toMatchObject({
      method: 'turn/start',
      prompt: '当前会话结束后继续',
      continuationNumber: 1,
    });
    if (!firstClaim) return;

    const deferred = await service.completeBridgeContinuationDispatch({
      taskId: manual.task.state.taskId,
      deliveryId: 'writer-contention-result',
      leaseToken: firstClaim.leaseToken,
      deviceId: 'device-writer-contention',
      outcome: 'rejected',
      failure: {
        message: 'thread thread-writer-contention already has an active writer',
      },
      now: 2_100,
    });
    expect(deferred.task?.state).toMatchObject({
      status: 'backoff',
      reason: 'backoff',
      continuationCount: 0,
      nextRunAtMs: 7_100,
      pendingPrompt: '当前会话结束后继续',
      pendingMethod: 'turn/start',
      pendingRouteAction: 'preserve',
      lease: null,
    });
    await expect(service.claimNextBridgeContinuationTask({
      ownerId: 'connector:device-writer-contention',
      deviceId: 'device-writer-contention',
      now: 7_099,
    })).resolves.toBeNull();

    const retryClaim = await service.claimNextBridgeContinuationTask({
      ownerId: 'connector:device-writer-contention',
      deviceId: 'device-writer-contention',
      now: 7_100,
    });
    expect(retryClaim?.command).toMatchObject({
      method: 'turn/start',
      prompt: '当前会话结束后继续',
      continuationNumber: 1,
    });
    if (!retryClaim) return;
    await service.completeBridgeContinuationDispatch({
      taskId: manual.task.state.taskId,
      deliveryId: 'writer-contention-retry-accepted',
      leaseToken: retryClaim.leaseToken,
      deviceId: 'device-writer-contention',
      outcome: 'accepted',
      turnId: 'turn-after-writer-release',
      now: 7_200,
    });
    expect((await service.getBridgeContinuationTask(manual.task.state.taskId))?.state).toMatchObject({
      status: 'waiting',
      reason: 'turn_active',
      continuationCount: 1,
      pendingPrompt: null,
      pendingMethod: null,
    });
    await expect(service.claimNextBridgeContinuationTask({
      ownerId: 'connector:device-writer-contention',
      deviceId: 'device-writer-contention',
      now: 7_300,
    })).resolves.toBeNull();
    const events = await service.listBridgeContinuationEvents(manual.task.state.taskId);
    expect(events.filter((event) => event.eventType === 'dispatch_deferred')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'continuation_dispatched')).toHaveLength(1);
  });

  it('waits for an already leased dispatch to reconcile before sending a replacement Prompt', async () => {
    await db.insert(schema.localConnectorDevices).values({
      id: 'device-a',
      name: 'MacBook',
      platform: 'macos',
      status: 'active',
      tokenHash: 'hash-device-a',
      scopes: '["app_server.control"]',
      pairedAt: '1970-01-01T00:00:01.000Z',
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z',
    }).run();
    const created = await service.createBridgeContinuationTask({
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      deviceId: 'device-a',
      policy: policy(),
      now: 1_000,
    });
    await service.recordBridgeContinuationFailure({
      taskId: created.task.state.taskId,
      failure: { source: 'turn_completed', httpStatusCode: 429, willRetry: false },
      threadStatus: 'idle',
      turnTerminal: true,
      now: 2_000,
    });
    const originalClaim = await service.claimNextBridgeContinuationTask({
      ownerId: 'connector:device-a',
      deviceId: 'device-a',
      leaseTtlMs: 10_000,
      now: 3_000,
    });
    expect(originalClaim?.task.state.status).toBe('running');
    if (!originalClaim) return;

    const replacement = await service.createManualBridgePromptTask({
      contextTaskId: created.task.state.taskId,
      prompt: '旧派发完成后再继续',
      submissionMode: 'start_next',
      source: 'webui',
      operatorId: 'webui:admin',
      idempotencyKey: 'webui-inflight-replacement',
      now: 3_100,
    });
    expect(replacement.task.state).toMatchObject({
      status: 'waiting',
      reason: 'thread_not_ready',
      pendingPrompt: '旧派发完成后再继续',
      pendingMethod: 'turn/start',
    });
    expect((await service.getBridgeContinuationTask(created.task.state.taskId))?.lease).not.toBeNull();
    await expect(service.claimNextBridgeContinuationTask({
      ownerId: 'connector:device-a',
      deviceId: 'device-a',
      now: 3_200,
    })).resolves.toBeNull();

    await expect(service.completeBridgeContinuationDispatch({
      taskId: created.task.state.taskId,
      deliveryId: 'old-dispatch-result',
      leaseToken: originalClaim.leaseToken,
      deviceId: 'device-a',
      outcome: 'accepted',
      turnId: 'turn-inflight',
      now: 3_300,
    })).resolves.toMatchObject({ updated: true, reason: 'accepted' });
    expect(await db.select().from(schema.bridgeContinuationLeases).all()).toHaveLength(0);

    const started = await service.recordBridgeContinuationAppServerEvent({
      deviceId: 'device-a',
      deliveryId: 'turn-inflight-started',
      event: { kind: 'turn_started', threadId: 'thread-a', turnId: 'turn-inflight' },
      now: 3_400,
    });
    expect(started.state).toMatchObject({
      taskId: replacement.task.state.taskId,
      status: 'waiting',
      reason: 'turn_active',
      pendingPrompt: '旧派发完成后再继续',
    });

    const completed = await service.recordBridgeContinuationAppServerEvent({
      deviceId: 'device-a',
      deliveryId: 'turn-inflight-completed',
      event: {
        kind: 'turn_completed',
        threadId: 'thread-a',
        turnId: 'turn-inflight',
        status: 'completed',
        failure: null,
      },
      now: 3_500,
    });
    expect(completed.state).toMatchObject({
      status: 'backoff',
      pendingMethod: 'turn/start',
      pendingPrompt: '旧派发完成后再继续',
      nextRunAtMs: 3_500,
    });
    const replacementClaim = await service.claimNextBridgeContinuationTask({
      ownerId: 'connector:device-a',
      deviceId: 'device-a',
      now: 3_500,
    });
    expect(replacementClaim).toMatchObject({
      task: { state: { taskId: replacement.task.state.taskId, status: 'running' } },
      command: { method: 'turn/start', prompt: '旧派发完成后再继续' },
    });
  });
});
