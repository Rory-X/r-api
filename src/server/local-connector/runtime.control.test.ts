import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConnectorConfig } from './config.js';

const control = vi.hoisted(() => ({
  options: null as null | {
    onNotification?: (event: import('./appServerControl.js').NormalizedAppServerControlEvent) => Promise<void> | void;
  },
  connect: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  listThreads: vi.fn(async () => [{
    threadId: 'thread-control',
    title: 'Local title',
    cwd: '/private/workspace',
    status: 'idle' as const,
    activeFlags: [],
    createdAt: null,
    updatedAt: '2026-08-11T02:00:00.000Z',
  }]),
  readLatestCompletedTurn: vi.fn(async () => null as import('./appServerControl.js').AppServerTurnCompletionSnapshot | null),
}));

vi.mock('./appServerControl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./appServerControl.js')>();
  return {
    ...actual,
    CodexAppServerControlClient: class {
      constructor(options: typeof control.options) {
        control.options = options;
      }
      connect = control.connect;
      close = control.close;
      listThreads = control.listThreads;
      readLatestCompletedTurn = control.readLatestCompletedTurn;
    },
  };
});

import {
  collectNewDesktopCompletions,
  LocalConnectorRuntime,
  selectExternallyOwnedDesktopThreads,
} from './runtime.js';

const roots: string[] = [];

afterEach(async () => {
  control.options = null;
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(dataDir: string): LocalConnectorConfig {
  return {
    protocol: 'metapi.local-connector.config.v1',
    serverUrl: 'http://127.0.0.1:4000',
    deviceId: 'device-control',
    connectorToken: 'lc_control',
    backupKey: Buffer.alloc(32).toString('base64url'),
    pairedAt: '2026-08-11T00:00:00.000Z',
    pollIntervalMs: 500,
    dataDir,
    appServerEndpoint: 'unix:/tmp/codex-control.sock',
  };
}

describe('local connector control runtime', () => {
  it('keeps only writer locks that the owned App Server has not loaded itself', () => {
    const threads = [{
      threadId: 'thread-external',
      status: 'loaded' as const,
      activeTurnId: null,
      updatedAt: '2026-08-11T02:00:00.000Z',
    }, {
      threadId: 'thread-owned',
      status: 'active' as const,
      activeTurnId: 'turn-owned',
      updatedAt: '2026-08-11T02:00:01.000Z',
    }];
    expect(selectExternallyOwnedDesktopThreads(new Map([
      ['thread-external', 'not_loaded'],
      ['thread-owned', 'active'],
    ]), threads)).toEqual([threads[0]]);
  });

  it('publishes App Server thread snapshots as controllable before polling Bridge tasks', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-control-'));
    roots.push(dataDir);
    const controller = new AbortController();
    const syncThreadSnapshots = vi.fn(async () => {
      controller.abort();
      return true;
    });
    const client = {
      emitEvent: vi.fn(async () => undefined),
      completeAction: vi.fn(async () => undefined),
      completeBridgeContinuation: vi.fn(async () => undefined),
      emitBridgeAppServerEvent: vi.fn(async () => undefined),
      claimNextAction: vi.fn(async () => null),
      claimNextBridgeContinuation: vi.fn(async () => null),
      syncThreadSnapshots,
    };
    const runtime = new LocalConnectorRuntime(
      config(dataDir),
      join(dataDir, 'config.json'),
      { executable: '/usr/bin/node', argv: ['/opt/connector.js'] },
      client as never,
    );

    await runtime.run({
      signal: controller.signal,
      controlAppServer: true,
      dashboard: false,
    });

    expect(control.connect).toHaveBeenCalledTimes(1);
    expect(control.listThreads).toHaveBeenCalledTimes(1);
    expect(syncThreadSnapshots).toHaveBeenCalledWith('connector_app_server', [{
      threadId: 'thread-control',
      title: 'Local title',
      cwd: '/private/workspace',
      status: 'idle',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-11T02:00:00.000Z',
    }]);
    expect(control.close).toHaveBeenCalledTimes(1);
  });

  it('detects each Desktop completion once without replaying history from before startup', () => {
    const watermarks = new Map<string, string>();
    const startedAtMs = Date.parse('2026-08-11T02:00:00.000Z');
    const completed = (turnId: string, lastTurnAt: string) => ({
      threadId: 'thread-desktop',
      status: 'loaded' as const,
      activeTurnId: null,
      lastTurnId: turnId,
      lastTurnStatus: 'completed' as const,
      lastTurnAt,
      updatedAt: lastTurnAt,
    });

    expect(collectNewDesktopCompletions(watermarks, [
      completed('turn-before-start', '2026-08-11T01:59:59.000Z'),
    ], startedAtMs)).toEqual([]);
    expect(collectNewDesktopCompletions(watermarks, [
      completed('turn-after-start', '2026-08-11T02:00:01.000Z'),
    ], startedAtMs)).toEqual([{
      threadId: 'thread-desktop',
      turnId: 'turn-after-start',
    }]);
    expect(collectNewDesktopCompletions(watermarks, [
      completed('turn-after-start', '2026-08-11T02:00:01.000Z'),
    ], startedAtMs)).toEqual([]);
    expect(collectNewDesktopCompletions(watermarks, [], startedAtMs)).toEqual([]);
    expect(collectNewDesktopCompletions(watermarks, [
      completed('turn-after-start', '2026-08-11T02:00:01.000Z'),
    ], startedAtMs)).toEqual([]);
  });

  it('reconciles a Desktop completion from active to idle when turn/completed is not broadcast', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-completion-'));
    roots.push(dataDir);
    const controller = new AbortController();
    control.listThreads.mockResolvedValue([{
      threadId: 'thread-control',
      title: 'Local title',
      cwd: '/private/workspace',
      status: 'active',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-11T02:00:00.000Z',
    }]);
    control.readLatestCompletedTurn
      .mockResolvedValueOnce({
        threadId: 'thread-control',
        turnId: 'turn-before-start',
        status: 'completed',
        assistantMessage: '历史回复',
        failure: null,
      })
      .mockResolvedValueOnce({
        threadId: 'thread-control',
        turnId: 'turn-before-start',
        status: 'completed',
        assistantMessage: '历史回复',
        failure: null,
      })
      .mockResolvedValueOnce({
        threadId: 'thread-control',
        turnId: 'turn-after-start',
        status: 'completed',
        assistantMessage: '本轮最终回复',
        failure: null,
      });
    const emitEvent = vi.fn(async () => {
      controller.abort();
    });
    const client = {
      emitEvent,
      completeAction: vi.fn(async () => undefined),
      completeBridgeContinuation: vi.fn(async () => undefined),
      emitBridgeAppServerEvent: vi.fn(async () => undefined),
      claimNextAction: vi.fn(async () => null),
      claimNextBridgeContinuation: vi.fn(async () => null),
      syncThreadSnapshots: vi.fn(async () => true),
    };
    const runtime = new LocalConnectorRuntime(
      config(dataDir),
      join(dataDir, 'config.json'),
      { executable: '/usr/bin/node', argv: ['/opt/connector.js'] },
      client as never,
    );

    const running = runtime.run({
      signal: controller.signal,
      controlAppServer: true,
      dashboard: false,
    });
    await vi.waitFor(() => expect(control.options?.onNotification).toBeTypeOf('function'));
    await vi.waitFor(() => expect(control.readLatestCompletedTurn).toHaveBeenCalledTimes(1));
    await control.options?.onNotification?.({
      kind: 'thread_status',
      threadId: 'thread-control',
      status: 'idle',
      activeFlags: [],
    });
    await control.options?.onNotification?.({
      kind: 'turn_completed',
      threadId: 'thread-control',
      turnId: 'turn-after-start',
      status: 'completed',
      assistantMessage: '本轮最终回复',
      failure: null,
    });
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
    await running;

    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'notify',
      title: 'Local title · Codex 会话已完成',
      idempotencyKey: 'turn:thread-control:turn-after-start',
      message: expect.stringContaining('会话名称：Local title'),
    }));
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('本轮最终回复'),
    }));
    expect(JSON.stringify(emitEvent.mock.calls)).not.toContain('历史回复');
  });

  it('notifies an ephemeral completion from active to idle without reading turns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-ephemeral-completion-'));
    roots.push(dataDir);
    const controller = new AbortController();
    control.listThreads.mockResolvedValue([{
      threadId: 'thread-ephemeral',
      title: 'Ephemeral task',
      cwd: '/private/workspace',
      status: 'active',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-12T02:00:00.000Z',
      ephemeral: true,
    }]);
    const emitEvent = vi.fn(async () => {
      controller.abort();
    });
    const client = {
      emitEvent,
      completeAction: vi.fn(async () => undefined),
      completeBridgeContinuation: vi.fn(async () => undefined),
      emitBridgeAppServerEvent: vi.fn(async () => undefined),
      claimNextAction: vi.fn(async () => null),
      claimNextBridgeContinuation: vi.fn(async () => null),
      syncThreadSnapshots: vi.fn(async () => true),
    };
    const runtime = new LocalConnectorRuntime(
      config(dataDir),
      join(dataDir, 'config.json'),
      { executable: '/usr/bin/node', argv: ['/opt/connector.js'] },
      client as never,
    );

    const running = runtime.run({
      signal: controller.signal,
      controlAppServer: true,
      dashboard: false,
    });
    await vi.waitFor(() => expect(control.options?.onNotification).toBeTypeOf('function'));
    await control.options?.onNotification?.({
      kind: 'thread_status',
      threadId: 'thread-ephemeral',
      status: 'idle',
      activeFlags: [],
    });
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
    await running;

    expect(control.readLatestCompletedTurn).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'notify',
      title: 'Ephemeral task · Codex 会话已完成',
      idempotencyKey: expect.stringMatching(/^turn:thread-ephemeral:ephemeral-[a-f0-9-]{36}$/),
      message: expect.stringMatching(/轮次 ID：ephemeral-[a-f0-9-]{36}/),
    }));
  });

  it('discovers a fast ephemeral thread from the read error and still notifies its completion', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-fast-ephemeral-completion-'));
    roots.push(dataDir);
    const controller = new AbortController();
    control.listThreads.mockResolvedValue([{
      threadId: 'thread-fast-ephemeral',
      title: 'Fast ephemeral task',
      cwd: '/private/workspace',
      status: 'active',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-12T02:00:00.000Z',
    }]);
    control.readLatestCompletedTurn.mockRejectedValue(
      new Error('ephemeral threads do not support includeTurns'),
    );
    const emitEvent = vi.fn(async () => {
      controller.abort();
    });
    const client = {
      emitEvent,
      completeAction: vi.fn(async () => undefined),
      completeBridgeContinuation: vi.fn(async () => undefined),
      emitBridgeAppServerEvent: vi.fn(async () => undefined),
      claimNextAction: vi.fn(async () => null),
      claimNextBridgeContinuation: vi.fn(async () => null),
      syncThreadSnapshots: vi.fn(async () => true),
    };
    const runtime = new LocalConnectorRuntime(
      config(dataDir),
      join(dataDir, 'config.json'),
      { executable: '/usr/bin/node', argv: ['/opt/connector.js'] },
      client as never,
    );

    const running = runtime.run({
      signal: controller.signal,
      controlAppServer: true,
      dashboard: false,
    });
    await vi.waitFor(() => expect(control.options?.onNotification).toBeTypeOf('function'));
    await control.options?.onNotification?.({
      kind: 'thread_status',
      threadId: 'thread-fast-ephemeral',
      status: 'idle',
      activeFlags: [],
    });
    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1));
    await running;

    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'notify',
      title: 'Fast ephemeral task · Codex 会话已完成',
      idempotencyKey: expect.stringMatching(/^turn:thread-fast-ephemeral:ephemeral-[a-f0-9-]{36}$/),
    }));
  });

  it('isolates one thread reconciliation failure from other concurrent threads', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-isolated-reconciliation-'));
    roots.push(dataDir);
    const controller = new AbortController();
    control.listThreads.mockResolvedValue([{
      threadId: 'thread-broken',
      title: 'Broken task',
      cwd: '/private/workspace',
      status: 'active',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-12T02:00:00.000Z',
    }, {
      threadId: 'thread-healthy',
      title: 'Healthy task',
      cwd: '/private/workspace',
      status: 'active',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-12T02:00:01.000Z',
    }]);
    control.readLatestCompletedTurn.mockImplementation(async (threadId: string) => {
      if (threadId === 'thread-broken') throw new Error('one thread is unreadable');
      return null;
    });
    const syncThreadSnapshots = vi.fn(async () => {
      controller.abort();
      return true;
    });
    const client = {
      emitEvent: vi.fn(async () => undefined),
      completeAction: vi.fn(async () => undefined),
      completeBridgeContinuation: vi.fn(async () => undefined),
      emitBridgeAppServerEvent: vi.fn(async () => undefined),
      claimNextAction: vi.fn(async () => null),
      claimNextBridgeContinuation: vi.fn(async () => null),
      syncThreadSnapshots,
    };
    const runtime = new LocalConnectorRuntime(
      config(dataDir),
      join(dataDir, 'config.json'),
      { executable: '/usr/bin/node', argv: ['/opt/connector.js'] },
      client as never,
    );

    await runtime.run({
      signal: controller.signal,
      controlAppServer: true,
      dashboard: false,
    });

    expect(control.readLatestCompletedTurn).toHaveBeenCalledWith('thread-broken');
    expect(control.readLatestCompletedTurn).toHaveBeenCalledWith('thread-healthy');
    expect(syncThreadSnapshots).toHaveBeenCalledWith(
      'connector_app_server',
      expect.arrayContaining([
        expect.objectContaining({ threadId: 'thread-broken' }),
        expect.objectContaining({ threadId: 'thread-healthy' }),
      ]),
    );
  });
});
