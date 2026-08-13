import getPort from 'get-port';
import { describe, expect, it } from 'vitest';
import { startLocalConnectorDashboardServer } from './dashboardServer.js';

describe('Local Connector dashboard server', () => {
  it('serves the standalone responsive dashboard and local status API', async () => {
    const port = await getPort({ host: '127.0.0.1' });
    const dashboard = await startLocalConnectorDashboardServer({
      host: '127.0.0.1',
      port,
      snapshot: async () => ({
        protocol: 'metapi.local-connector.dashboard.v1',
        generatedAt: '2026-08-06T09:00:00.000Z',
        connector: {
          deviceId: 'device-a',
          serverUrl: 'https://metapi.example.com',
          dataDir: '/tmp/metapi',
          pid: 123,
          startedAt: '2026-08-06T08:00:00.000Z',
          status: 'online',
          pollIntervalMs: 2_000,
          lastServerSuccessAt: '2026-08-06T09:00:00.000Z',
          lastServerErrorAt: null,
          lastServerError: null,
          consecutiveServerFailures: 0,
          activeActionId: null,
          activeBridgeTaskId: null,
          threadSnapshotSyncStatus: 'unsupported',
          lastThreadSnapshotSyncAt: '2026-08-06T09:00:00.000Z',
          lastThreadSnapshotSyncError: '线上服务尚未部署 Desktop session snapshot 接口',
        },
        appServer: { mode: 'control', status: 'connected', endpoint: 'unix:/tmp/codex.sock', lastError: null },
        summary: { activeSessions: 0, waitingInteractions: 0, queuedDeliveries: 0 },
        sessions: [{
          threadId: 'thread-a',
          title: 'Desktop task',
          cwd: '/workspace/metapi',
          status: 'active',
          source: 'codex_desktop',
          controlState: 'external_owner',
          activeFlags: [],
          activeTurnId: 'turn-a',
          lastTurnStatus: null,
          lastError: null,
          createdAt: null,
          updatedAt: '2026-08-06T09:00:00.000Z',
        }],
        interactions: [],
        queue: { events: 0, results: 0, bridgeEvents: 0, bridgeResults: 0, total: 0 },
        events: [],
      }),
    });
    try {
      expect(dashboard.healthUrl).toBe(`http://127.0.0.1:${dashboard.port}/healthz`);
      expect(dashboard.statusUrl).toBe(`http://127.0.0.1:${dashboard.port}/api/status`);

      const health = await fetch(dashboard.healthUrl);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ success: true });

      const response = await fetch(`http://127.0.0.1:${dashboard.port}/api/status`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        protocol: 'metapi.local-connector.dashboard.v1',
        connector: { deviceId: 'device-a', status: 'online' },
      });

      const page = await fetch(`http://127.0.0.1:${dashboard.port}/`);
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      const html = await page.text();
      expect(html).toContain('r-api Connector');
      expect(html).toContain('@media(max-width:640px)');
      expect(html).toContain('/api/status');
      expect(html).toContain('Codex Desktop · 可追加消息');
      expect(html).toContain('Codex 交互审批');
      expect(html).not.toContain('App Server / Feishu');
    } finally {
      await dashboard.close();
    }
  });
});
