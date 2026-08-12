import { join } from 'node:path';
import { atomicRemoveFile, atomicWriteFile, readOptionalFile } from './atomicFile.js';
import type { ConnectorDashboardSnapshot } from './dashboardState.js';
import type { LocalConnectorDashboardServer } from './dashboardServer.js';
import { CONNECTOR_VERSION } from './identity.js';

const DASHBOARD_DISCOVERY_FILENAME = 'connector.dashboard.json';
const DASHBOARD_DISCOVERY_PROTOCOL = 'metapi.local-connector.dashboard-discovery.v1' as const;
const MAX_DASHBOARD_RESPONSE_BYTES = 256 * 1024;

export type LocalConnectorDashboardDiscovery = Readonly<{
  protocol: typeof DASHBOARD_DISCOVERY_PROTOCOL;
  version: string;
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  urls: readonly string[];
  healthUrl: string;
  statusUrl: string;
}>;

export type LocalConnectorDashboardInspection = Readonly<{
  discoveryPath: string;
  available: boolean;
  runtimeVersion: string | null;
  pid: number | null;
  matchesRuntime: boolean | null;
  urls: readonly string[];
  url: string | null;
  healthUrl: string | null;
  statusUrl: string | null;
  reachable: boolean;
  error: string | null;
  snapshot: Readonly<{
    protocol: string;
    generatedAt: string | null;
    connectorStatus: string | null;
    threadSnapshotSyncStatus: string | null;
    appServer: ConnectorDashboardSnapshot['appServer'] | null;
    summary: ConnectorDashboardSnapshot['summary'] | null;
  }> | null;
}>;

function discoveryPath(dataDir: string): string {
  return join(dataDir, DASHBOARD_DISCOVERY_FILENAME);
}

function normalizedUrl(value: unknown, expectedPath: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password || url.hash || url.pathname !== expectedPath) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseDiscovery(value: Buffer): LocalConnectorDashboardDiscovery | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
    const pid = Math.trunc(Number(parsed.pid));
    const port = Math.trunc(Number(parsed.port));
    const startedAt = typeof parsed.startedAt === 'string' && Number.isFinite(Date.parse(parsed.startedAt))
      ? parsed.startedAt
      : null;
    const host = typeof parsed.host === 'string' ? parsed.host.trim() : '';
    const healthUrl = normalizedUrl(parsed.healthUrl, '/healthz');
    const statusUrl = normalizedUrl(parsed.statusUrl, '/api/status');
    const urls = Array.isArray(parsed.urls)
      ? parsed.urls.flatMap((item) => {
        const url = normalizedUrl(item, '/');
        return url ? [url] : [];
      })
      : [];
    if (parsed.protocol !== DASHBOARD_DISCOVERY_PROTOCOL
      || !version || version.length > 64
      || !Number.isInteger(pid) || pid <= 0
      || !Number.isInteger(port) || port <= 0 || port > 65_535
      || !startedAt || !host || !healthUrl || !statusUrl || urls.length === 0) {
      return null;
    }
    const status = new URL(statusUrl);
    const health = new URL(healthUrl);
    if (status.origin !== health.origin || status.search !== health.search || Number(status.port || 80) !== port) {
      return null;
    }
    return Object.freeze({
      protocol: DASHBOARD_DISCOVERY_PROTOCOL,
      version,
      pid,
      startedAt,
      host,
      port,
      urls: Object.freeze(urls),
      healthUrl,
      statusUrl,
    });
  } catch {
    return null;
  }
}

export async function writeLocalConnectorDashboardDiscovery(
  dataDir: string,
  dashboard: LocalConnectorDashboardServer,
): Promise<void> {
  const discovery: LocalConnectorDashboardDiscovery = Object.freeze({
    protocol: DASHBOARD_DISCOVERY_PROTOCOL,
    version: CONNECTOR_VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: dashboard.host,
    port: dashboard.port,
    urls: Object.freeze([...dashboard.urls]),
    healthUrl: dashboard.healthUrl,
    statusUrl: dashboard.statusUrl,
  });
  await atomicWriteFile(discoveryPath(dataDir), `${JSON.stringify(discovery, null, 2)}\n`, 0o600);
}

export async function clearLocalConnectorDashboardDiscovery(
  dataDir: string,
  ownerPid: number | null = process.pid,
): Promise<void> {
  const path = discoveryPath(dataDir);
  const snapshot = await readOptionalFile(path, 32 * 1024);
  if (!snapshot.exists) return;
  const discovery = parseDiscovery(snapshot.data);
  if (ownerPid === null || discovery?.pid === ownerPid) {
    await atomicRemoveFile(path).catch(() => undefined);
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DASHBOARD_RESPONSE_BYTES) {
    throw new Error('本地看板响应过大');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_DASHBOARD_RESPONSE_BYTES) throw new Error('本地看板响应过大');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('本地看板响应格式无效');
  return parsed as Record<string, unknown>;
}

export async function inspectLocalConnectorDashboard(
  dataDir: string,
  runtimePid: number | null,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalConnectorDashboardInspection> {
  const path = discoveryPath(dataDir);
  const snapshot = await readOptionalFile(path, 32 * 1024);
  const discovery = snapshot.exists ? parseDiscovery(snapshot.data) : null;
  if (!discovery) {
    return Object.freeze({
      discoveryPath: path,
      available: false,
      runtimeVersion: null,
      pid: null,
      matchesRuntime: null,
      urls: Object.freeze([]),
      url: null,
      healthUrl: null,
      statusUrl: null,
      reachable: false,
      error: snapshot.exists ? '本地看板 discovery 文件无效' : null,
      snapshot: null,
    });
  }

  const matchesRuntime = runtimePid === null ? null : discovery.pid === runtimePid;
  if (matchesRuntime === false) {
    return Object.freeze({
      discoveryPath: path,
      available: true,
      runtimeVersion: discovery.version,
      pid: discovery.pid,
      matchesRuntime,
      urls: discovery.urls,
      url: discovery.urls[0] || null,
      healthUrl: discovery.healthUrl,
      statusUrl: discovery.statusUrl,
      reachable: false,
      error: '本地看板属于另一个 Connector 进程',
      snapshot: null,
    });
  }

  try {
    const [healthResponse, statusResponse] = await Promise.all([
      fetchImpl(discovery.healthUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(2_000),
      }),
      fetchImpl(discovery.statusUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(2_000),
        headers: { accept: 'application/json' },
      }),
    ]);
    if (!healthResponse.ok) throw new Error(`本地看板健康检查返回 HTTP ${healthResponse.status}`);
    if (!statusResponse.ok) throw new Error(`本地看板状态接口返回 HTTP ${statusResponse.status}`);
    const status = await responseJson(statusResponse);
    const connector = status.connector && typeof status.connector === 'object' && !Array.isArray(status.connector)
      ? status.connector as Record<string, unknown>
      : {};
    const appServer = status.appServer && typeof status.appServer === 'object' && !Array.isArray(status.appServer)
      ? status.appServer as ConnectorDashboardSnapshot['appServer']
      : null;
    const summary = status.summary && typeof status.summary === 'object' && !Array.isArray(status.summary)
      ? status.summary as ConnectorDashboardSnapshot['summary']
      : null;
    return Object.freeze({
      discoveryPath: path,
      available: true,
      runtimeVersion: discovery.version,
      pid: discovery.pid,
      matchesRuntime,
      urls: discovery.urls,
      url: discovery.urls[0] || null,
      healthUrl: discovery.healthUrl,
      statusUrl: discovery.statusUrl,
      reachable: true,
      error: null,
      snapshot: Object.freeze({
        protocol: typeof status.protocol === 'string' ? status.protocol : 'unknown',
        generatedAt: typeof status.generatedAt === 'string' ? status.generatedAt : null,
        connectorStatus: typeof connector.status === 'string' ? connector.status : null,
        threadSnapshotSyncStatus: typeof connector.threadSnapshotSyncStatus === 'string'
          ? connector.threadSnapshotSyncStatus
          : null,
        appServer,
        summary,
      }),
    });
  } catch (error) {
    return Object.freeze({
      discoveryPath: path,
      available: true,
      runtimeVersion: discovery.version,
      pid: discovery.pid,
      matchesRuntime,
      urls: discovery.urls,
      url: discovery.urls[0] || null,
      healthUrl: discovery.healthUrl,
      statusUrl: discovery.statusUrl,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
      snapshot: null,
    });
  }
}
