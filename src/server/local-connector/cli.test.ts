import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import getPort from 'get-port';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchCodexNotify } from './cli.js';
import { saveLocalConnectorConfig } from './config.js';
import { writeLocalConnectorDashboardDiscovery } from './dashboardDiscovery.js';
import { startLocalConnectorDashboardServer } from './dashboardServer.js';
import { rememberLocalConnectorThreadMetadata } from './threadMetadata.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      resolve('src/server/local-connector/cli.ts'),
      ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function createCliFixture() {
  const root = await mkdtemp(join(tmpdir(), 'metapi-connector-cli-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const configPath = join(dataDir, 'config.json');
  const heartbeatRequests: Array<Readonly<{ contentLength: string | undefined; contentType: string | undefined }>> = [];
  const remote = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/local-connector/public/heartbeat') {
      heartbeatRequests.push({
        contentLength: request.headers['content-length'],
        contentType: request.headers['content-type'],
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        success: true,
        device: { id: 'device-cli', status: 'active' },
        serverTime: '2026-08-12T12:00:00.000Z',
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const remotePort = await listen(remote);
  await saveLocalConnectorConfig(configPath, {
    protocol: 'metapi.local-connector.config.v1',
    serverUrl: `http://127.0.0.1:${remotePort}`,
    deviceId: 'device-cli',
    connectorToken: 'lc_test_connector_token_abcdefghijklmnopqrstuvwxyz',
    backupKey: randomBytes(32).toString('base64url'),
    pairedAt: '2026-08-12T00:00:00.000Z',
    pollIntervalMs: 2_000,
    dataDir,
    appServerEndpoint: null,
  });
  await writeFile(join(dataDir, 'connector.lock'), `${JSON.stringify({
    pid: process.pid,
    startedAt: '2026-08-12T11:00:00.000Z',
    serviceManager: null,
    serviceLabel: null,
  })}\n`, { mode: 0o600 });
  await writeFile(join(dataDir, 'connector.pid'), `${process.pid}\n`, { mode: 0o600 });

  const preferredPort = await getPort({
    host: '127.0.0.1',
    port: Array.from({ length: 50 }, (_, index) => 48_500 + index),
  });
  const blocker = createServer((_request, response) => response.end('occupied'));
  await listen(blocker, preferredPort);
  const dashboard = await startLocalConnectorDashboardServer({
    host: '127.0.0.1',
    port: preferredPort,
    snapshot: async () => ({
      protocol: 'metapi.local-connector.dashboard.v1',
      generatedAt: '2026-08-12T12:00:00.000Z',
      connector: {
        deviceId: 'device-cli',
        serverUrl: `http://127.0.0.1:${remotePort}`,
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
      summary: { activeSessions: 3, waitingInteractions: 1, queuedDeliveries: 2 },
      sessions: [],
      interactions: [],
      queue: { events: 1, results: 0, bridgeEvents: 1, bridgeResults: 0, total: 2 },
      events: [],
    }),
  });
  await writeLocalConnectorDashboardDiscovery(dataDir, dashboard);
  return { blocker, configPath, dashboard, heartbeatRequests, preferredPort, remote };
}

describe('local connector CLI notify dispatcher', () => {
  it('durably queues the native Codex completion payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metapi-connector-notify-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const configPath = join(dataDir, 'config.json');
    await saveLocalConnectorConfig(configPath, {
      protocol: 'metapi.local-connector.config.v1',
      serverUrl: 'http://127.0.0.1:4000',
      deviceId: 'device-notify',
      connectorToken: 'lc_test_connector_token_abcdefghijklmnopqrstuvwxyz',
      backupKey: randomBytes(32).toString('base64url'),
      pairedAt: '2026-08-12T00:00:00.000Z',
      pollIntervalMs: 2_000,
      dataDir,
      appServerEndpoint: null,
    });
    await rememberLocalConnectorThreadMetadata({
      dataDir,
      threads: [{ threadId: 'thread-native', title: 'Native session' }],
    });

    await dispatchCodexNotify({ config: configPath }, JSON.stringify({
      type: 'agent-turn-complete',
      'thread-id': 'thread-native',
      'turn-id': 'turn-native',
      'last-assistant-message': 'native notify completed',
    }));

    const files = await readdir(join(dataDir, 'events'));
    expect(files).toHaveLength(1);
    const event = JSON.parse(await readFile(join(dataDir, 'events', files[0]!), 'utf8'));
    expect(event).toMatchObject({
      kind: 'notify',
      title: 'Native session · Codex 任务已完成',
      idempotencyKey: 'turn:thread-native:turn-native',
    });
    expect(event.message).toContain('会话名称：Native session');
    expect(event.message).toContain('native notify completed');
  });
});

describe('local connector CLI operations', () => {
  it('prints command-specific help without requiring a Connector config', async () => {
    const runHelp = await runCli(['run', '--help']);
    expect(runHelp).toMatchObject({ code: 0, stderr: '' });
    expect(runHelp.stdout).toContain('metapi-connector run [--config PATH] --direct');
    expect(runHelp.stdout).toContain('--dashboard-port PORT');
    expect(runHelp.stdout).not.toContain('Commands:');

    const doctorHelp = await runCli(['doctor', '-h']);
    expect(doctorHelp).toMatchObject({ code: 0, stderr: '' });
    expect(doctorHelp.stdout).toContain('metapi-connector doctor [--config PATH]');
    expect(doctorHelp.stdout).toContain('sets a non-zero exit code');
  });

  it('reports the actual dashboard URL and passes doctor only when session control is ready', async () => {
    const fixture = await createCliFixture();
    let dashboardClosed = false;
    try {
      expect(fixture.dashboard.port).not.toBe(fixture.preferredPort);

      const statusResult = await runCli(['status', '--config', fixture.configPath]);
      expect(statusResult).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(statusResult.stdout)).toMatchObject({
        success: true,
        cliVersion: '1.0.4',
        runtimeVersion: '1.0.4',
        remote: { reachable: true, error: null },
        local: {
          lockStatus: 'active',
          running: true,
          pid: process.pid,
          pidFileMatchesLock: true,
        },
        dashboard: {
          reachable: true,
          url: fixture.dashboard.urls[0],
          snapshot: {
            connectorStatus: 'online',
            threadSnapshotSyncStatus: 'supported',
            appServer: { mode: 'control', status: 'connected' },
            summary: { activeSessions: 3, waitingInteractions: 1, queuedDeliveries: 2 },
          },
        },
      });

      const dashboardResult = await runCli(['dashboard', '--config', fixture.configPath]);
      expect(dashboardResult).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(dashboardResult.stdout)).toMatchObject({
        success: true,
        opened: false,
        url: fixture.dashboard.urls[0],
        healthUrl: fixture.dashboard.healthUrl,
        statusUrl: fixture.dashboard.statusUrl,
      });

      const passingDoctor = await runCli(['doctor', '--config', fixture.configPath]);
      expect(passingDoctor).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(passingDoctor.stdout)).toMatchObject({
        success: true,
        readyForSessionControl: true,
        dashboardUrl: fixture.dashboard.urls[0],
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'app_server', status: 'pass' }),
          expect.objectContaining({ id: 'runtime_version', status: 'pass' }),
          expect.objectContaining({ id: 'thread_snapshot', status: 'pass' }),
          expect.objectContaining({ id: 'remote', status: 'pass' }),
        ]),
      });

      const discoveryPath = join(join(fixture.configPath, '..'), 'connector.dashboard.json');
      const oldRuntimeDiscovery = JSON.parse(await readFile(discoveryPath, 'utf8'));
      oldRuntimeDiscovery.version = '1.0.1';
      await writeFile(discoveryPath, `${JSON.stringify(oldRuntimeDiscovery, null, 2)}\n`, { mode: 0o600 });
      const mismatchedDoctor = await runCli(['doctor', '--config', fixture.configPath]);
      expect(mismatchedDoctor.code).toBe(1);
      expect(JSON.parse(mismatchedDoctor.stdout)).toMatchObject({
        success: false,
        readyForSessionControl: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'runtime_version',
            status: 'fail',
            detail: 'cli=1.0.4 runtime=1.0.1',
          }),
        ]),
      });
      oldRuntimeDiscovery.version = '1.0.4';
      await writeFile(discoveryPath, `${JSON.stringify(oldRuntimeDiscovery, null, 2)}\n`, { mode: 0o600 });

      await fixture.dashboard.close();
      dashboardClosed = true;
      const failingDoctor = await runCli(['doctor', '--config', fixture.configPath]);
      expect(failingDoctor.code).toBe(1);
      expect(JSON.parse(failingDoctor.stdout)).toMatchObject({
        success: false,
        readyForSessionControl: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'dashboard', status: 'fail' }),
          expect.objectContaining({ id: 'runtime_version', status: 'pass' }),
          expect.objectContaining({ id: 'app_server', status: 'fail' }),
        ]),
      });
      expect(fixture.heartbeatRequests).not.toHaveLength(0);
      expect(fixture.heartbeatRequests).toEqual(expect.arrayContaining([
        { contentLength: '0', contentType: undefined },
      ]));
    } finally {
      if (!dashboardClosed) await fixture.dashboard.close();
      await Promise.all([closeServer(fixture.blocker), closeServer(fixture.remote)]);
    }
  }, 10_000);
});
