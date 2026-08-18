import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLocalConnectorDashboardDiscovery,
  inspectLocalConnectorDashboard,
  writeLocalConnectorDashboardDiscovery,
} from './dashboardDiscovery.js';
import { startLocalConnectorDashboardServer } from './dashboardServer.js';
import { canBindLocalTestListener } from '../test-fixtures/localListenerCapability.js';

const roots: string[] = [];
const describeWithLocalListener = canBindLocalTestListener() ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startFixture(dataDir: string) {
  const dashboard = await startLocalConnectorDashboardServer({
    host: '127.0.0.1',
    port: 49_000,
    snapshot: async () => ({
      protocol: 'metapi.local-connector.dashboard.v1',
      generatedAt: '2026-08-12T12:00:00.000Z',
      connector: {
        deviceId: 'device-discovery',
        serverUrl: 'https://metapi.example.com',
        dataDir,
        pid: process.pid,
        startedAt: '2026-08-12T11:00:00.000Z',
        status: 'online',
        pollIntervalMs: 2_000,
        lastServerSuccessAt: '2026-08-12T12:00:00.000Z',
        lastServerErrorAt: null,
        lastServerError: null,
        consecutiveServerFailures: 0,
        activeActionId: null,
        activeBridgeTaskId: null,
        threadSnapshotSyncStatus: 'supported',
        lastThreadSnapshotSyncAt: '2026-08-12T12:00:00.000Z',
        lastThreadSnapshotSyncError: null,
      },
      appServer: {
        mode: 'control',
        status: 'connected',
        endpoint: 'unix:/tmp/codex.sock',
        lastError: null,
      },
      summary: { activeSessions: 2, waitingInteractions: 1, queuedDeliveries: 0 },
      sessions: [],
      interactions: [],
      queue: { events: 0, results: 0, bridgeEvents: 0, bridgeResults: 0, total: 0 },
      events: [],
    }),
  });
  await writeLocalConnectorDashboardDiscovery(dataDir, dashboard);
  return dashboard;
}

describeWithLocalListener('local Connector dashboard discovery', () => {
  it('writes a private file and probes the actual dashboard endpoint', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-dashboard-discovery-'));
    roots.push(dataDir);
    const dashboard = await startFixture(dataDir);
    try {
      const path = join(dataDir, 'connector.dashboard.json');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const serialized = JSON.parse(await readFile(path, 'utf8'));
      expect(serialized).toMatchObject({
        protocol: 'metapi.local-connector.dashboard-discovery.v1',
        version: '1.0.4',
        pid: process.pid,
        port: dashboard.port,
        healthUrl: dashboard.healthUrl,
        statusUrl: dashboard.statusUrl,
      });

      await expect(inspectLocalConnectorDashboard(dataDir, process.pid)).resolves.toMatchObject({
        available: true,
        runtimeVersion: '1.0.4',
        matchesRuntime: true,
        url: dashboard.urls[0],
        reachable: true,
        snapshot: {
          connectorStatus: 'online',
          threadSnapshotSyncStatus: 'supported',
          appServer: { mode: 'control', status: 'connected' },
          summary: { activeSessions: 2, waitingInteractions: 1 },
        },
      });
    } finally {
      await dashboard.close();
    }
  });

  it('rejects discovery owned by a different runtime without probing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-dashboard-owner-'));
    roots.push(dataDir);
    const dashboard = await startFixture(dataDir);
    try {
      const inspection = await inspectLocalConnectorDashboard(dataDir, process.pid + 1, async () => {
        throw new Error('should not probe a mismatched runtime');
      });
      expect(inspection).toMatchObject({
        available: true,
        runtimeVersion: '1.0.4',
        matchesRuntime: false,
        reachable: false,
        error: '本地看板属于另一个 Connector 进程',
      });
    } finally {
      await dashboard.close();
    }
  });

  it('reports invalid files and only removes another owner when explicitly clearing stale discovery', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-dashboard-invalid-'));
    roots.push(dataDir);
    const path = join(dataDir, 'connector.dashboard.json');
    await writeFile(path, '{"protocol":"invalid"}\n', { mode: 0o600 });

    await expect(inspectLocalConnectorDashboard(dataDir, process.pid)).resolves.toMatchObject({
      available: false,
      reachable: false,
      error: '本地看板 discovery 文件无效',
    });
    await clearLocalConnectorDashboardDiscovery(dataDir);
    await expect(readFile(path)).resolves.toBeInstanceOf(Buffer);
    await clearLocalConnectorDashboardDiscovery(dataDir, null);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let an old process remove the current process discovery', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-dashboard-cleanup-'));
    roots.push(dataDir);
    const dashboard = await startFixture(dataDir);
    try {
      const path = join(dataDir, 'connector.dashboard.json');
      await clearLocalConnectorDashboardDiscovery(dataDir, process.pid + 1);
      await expect(readFile(path)).resolves.toBeInstanceOf(Buffer);
      await clearLocalConnectorDashboardDiscovery(dataDir, process.pid);
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await dashboard.close();
    }
  });
});
