import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalConnectorDashboardState } from './dashboardState.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Local Connector dashboard state', () => {
  it('keeps live session state, pending interactions, and durable queue counts local', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-dashboard-state-'));
    roots.push(dataDir);
    await mkdir(join(dataDir, 'bridge-events'));
    await writeFile(join(dataDir, 'bridge-events', '0000000000000001-event-12345678-1234-1234-1234-123456789abc.json'), '{}');

    const state = new LocalConnectorDashboardState({
      deviceId: 'device-a',
      serverUrl: 'https://metapi.example.com',
      dataDir,
      pollIntervalMs: 2_000,
    });
    state.configureAppServer({ mode: 'control', endpoint: 'unix:/tmp/codex.sock' });
    state.markAppServerConnected();
    state.markServerSuccess();
    state.markThreadSnapshotSyncUnsupported();
    state.syncThreads([{
      threadId: 'thread-a',
      title: 'Connector dashboard',
      cwd: '/workspace/metapi',
      status: 'unknown',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-06T09:00:00.000Z',
    }]);
    state.recordControlEvent({
      kind: 'turn_started',
      threadId: 'thread-a',
      turnId: 'turn-a',
    });
    state.syncThreads([{
      threadId: 'thread-a',
      title: 'Connector dashboard',
      cwd: '/workspace/metapi',
      status: 'unknown',
      activeFlags: [],
      createdAt: null,
      updatedAt: '2026-08-06T09:00:00.000Z',
    }]);

    const snapshot = await state.snapshot([{
      sourceRequestId: '77',
      interactionId: 'interaction-a',
      method: 'item/commandExecution/requestApproval',
      kind: 'command_approval',
      threadId: 'thread-a',
      turnId: 'turn-a',
      status: 'waiting',
      expiresAt: '2026-08-06T09:15:00.000Z',
      updatedAt: '2026-08-06T09:01:00.000Z',
    }]);

    expect(snapshot.connector.status).toBe('online');
    expect(snapshot.connector).toMatchObject({
      threadSnapshotSyncStatus: 'unsupported',
      lastThreadSnapshotSyncError: expect.stringContaining('尚未部署'),
    });
    expect(snapshot.summary).toEqual({
      activeSessions: 1,
      waitingInteractions: 1,
      queuedDeliveries: 1,
    });
    expect(snapshot.sessions[0]).toMatchObject({
      threadId: 'thread-a',
      status: 'active',
      activeTurnId: 'turn-a',
    });
    expect(snapshot.queue.bridgeEvents).toBe(1);
  });

  it('shows externally owned Codex Desktop turns without claiming connector control', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-dashboard-state-'));
    roots.push(dataDir);
    const state = new LocalConnectorDashboardState({
      deviceId: 'device-a',
      serverUrl: 'https://metapi.example.com',
      dataDir,
      pollIntervalMs: 2_000,
    });
    const observedAt = new Date().toISOString();
    state.syncThreads([{
      threadId: 'thread-desktop',
      title: 'Desktop task',
      cwd: '/workspace/metapi',
      status: 'not_loaded',
      activeFlags: [],
      createdAt: null,
      updatedAt: observedAt,
    }]);
    state.syncDesktopSessions([{
      threadId: 'thread-desktop',
      status: 'active',
      activeTurnId: 'turn-desktop',
      updatedAt: observedAt,
    }]);

    const active = await state.snapshot();
    expect(active.summary.activeSessions).toBe(1);
    expect(active.sessions[0]).toMatchObject({
      status: 'active',
      source: 'codex_desktop',
      controlState: 'external_owner',
      activeTurnId: 'turn-desktop',
    });

    state.syncDesktopSessions([]);
    const released = await state.snapshot();
    expect(released.sessions[0]).toMatchObject({
      status: 'not_loaded',
      source: 'connector_app_server',
      controlState: 'available',
      activeTurnId: null,
    });
  });
});
