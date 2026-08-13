#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOptionalFile } from './atomicFile.js';
import { LocalConnectorClient } from './client.js';
import {
  createLocalConnectorConfig,
  loadLocalConnectorConfig,
  resolveLocalConnectorConfigPath,
  saveLocalConnectorConfig,
} from './config.js';
import {
  isCodexTurnCompletionHook,
  localAgentEventThreadId,
  normalizeLocalAgentEvent,
} from './eventPayload.js';
import { enqueueLocalConnectorEvent } from './queue.js';
import { LocalConnectorRuntime } from './runtime.js';
import type { LocalConnectorAgent } from './protocol.js';
import { reloadCodexRuntime, watchCodexRuntimeConfig } from './codexRuntimeReload.js';
import { readLocalConnectorThreadTitle } from './threadMetadata.js';
import { inspectConnectorRuntimeState } from './runtimeState.js';
import { inspectLocalConnectorDashboard } from './dashboardDiscovery.js';
import { CONNECTOR_VERSION, LOCAL_CONNECTOR_CAPABILITIES } from './identity.js';
import {
  installLocalConnectorServices,
  uninstallLocalConnectorServices,
} from './launchAgent.js';

const HELP = `r-api Local Connector

Install:
  npm install --global metapi-connector
  metapi-connector --version

Commands:
  pair    --server URL --pairing-id ID --pairing-token TOKEN [--config PATH]
  run     [--config PATH] [--once] [--direct]
  status  [--config PATH] [--connector-launchd-label LABEL]
  doctor  [--config PATH] [--connector-launchd-label LABEL]
  dashboard [--config PATH] [--open]
  install-service --connector-launchd-label LABEL [--config PATH]
  uninstall-service --connector-launchd-label LABEL
  emit    --kind hook|notify --agent codex|claude_code [--config PATH] [JSON]
  dispatch-codex-notify --config PATH [--forward-notify JSON_ARGV] [JSON]
  reload-codex-runtime --codex-executable PATH --connector-launchd-label LABEL
  watch-codex-runtime  --codex-home PATH --codex-executable PATH --connector-launchd-label LABEL

Local-only options:
  --app-server-endpoint ENDPOINT   Save a local unix socket or named pipe endpoint when pairing
  --owned-app-server EXECUTABLE    Start an isolated "EXECUTABLE app-server" process with shell=false
  --direct                         Control the official managed local App Server daemon
  --control-app-server             Use an explicit owner client for Bridge continuation commands
  --poll-interval MS               Poll interval written during pairing (500-60000)
  --dashboard-host HOST            Dashboard bind host (default 127.0.0.1)
  --dashboard-port PORT            Dashboard preferred port (default 4765)
  --no-dashboard                   Disable the local Connector dashboard
  --codex-executable PATH          Codex CLI used to restart the managed App Server daemon
  --connector-launchd-label LABEL  launchd label for the Local Connector service
  --app-server-socket PATH         Managed App Server control socket to wait for
  --connector-health-url URL       Connector health endpoint checked after restart
  --debounce-ms MS                 Delay before reload so atomic config writes can settle
  --codex-home PATH                Directory containing auth.json and config.toml
  --watch-interval-ms MS           Config fingerprint polling interval (minimum 250)

Status:
  status reports local process, dashboard, App Server and remote reachability separately.
  doctor turns the same evidence into pass/warn/fail checks for session control.

Recommended flow:
  metapi-connector pair ...
  metapi-connector run --direct
  metapi-connector doctor
  metapi-connector dashboard --open
  metapi-connector install-service --connector-launchd-label com.metapi.localconnector.default
`;

const COMMAND_HELP: Record<string, string> = {
  pair: `Usage:
  metapi-connector pair --server URL --pairing-id ID --pairing-token TOKEN [options]

Options:
  --config PATH                  Config file to create
  --poll-interval MS             Server polling interval (500-60000, default 2000)
  --app-server-endpoint ENDPOINT Explicit App Server socket or named pipe
  --force                        Replace an existing config after revoking the old device
`,
  run: `Usage:
  metapi-connector run [--config PATH] --direct [dashboard options]
  metapi-connector run [--config PATH] --once

Recommended:
  --direct                       Connect to the official managed Codex App Server daemon

Dashboard options:
  --dashboard-host HOST          Bind host (default 127.0.0.1)
  --dashboard-port PORT          Preferred port (default 4765; may fall forward by 2)
  --no-dashboard                 Disable the local dashboard

Compatibility / advanced:
  --control-app-server           Compatibility alias for explicit control mode
  --observe-app-server           Observe an explicit App Server without control
  --owned-app-server EXECUTABLE  Start an isolated "EXECUTABLE app-server" process
`,
  status: `Usage:
  metapi-connector status [--config PATH] [--connector-launchd-label LABEL]

Returns JSON for remote heartbeat, local lock/PID/launchd state, the discovered
dashboard URL, App Server connection and current session/queue summary.
`,
  doctor: `Usage:
  metapi-connector doctor [--config PATH] [--connector-launchd-label LABEL]

Runs local-first checks for config, process ownership, launchd, dashboard,
App Server control, session snapshot upload and remote heartbeat. The command
sets a non-zero exit code when session control is not ready.
`,
  dashboard: `Usage:
  metapi-connector dashboard [--config PATH] [--open]

Reads the dashboard discovery file written by the running Connector, probes its
health endpoint and prints the actual URL even when port 4765 was unavailable.
Use --open to launch the URL in the default browser on macOS.
`,
  'install-service': `Usage:
  metapi-connector install-service --connector-launchd-label LABEL [options]

Installs or upgrades the macOS Connector LaunchAgent from the standalone npm
package, plus a Codex configuration watcher by default. Existing plist files are
backed up under the Connector data directory. The command verifies session
control readiness before returning success.

Options:
  --reloader-launchd-label LABEL  Watcher label (default LABEL.codex-runtime)
  --codex-home PATH               Codex home (default $CODEX_HOME or ~/.codex)
  --codex-executable PATH         Codex binary under the standalone package
  --app-server-socket PATH        Managed App Server control socket
  --dashboard-port PORT           Preferred local dashboard port (default 4765)
  --no-config-watcher             Install only the Connector service
`,
  'uninstall-service': `Usage:
  metapi-connector uninstall-service --connector-launchd-label LABEL [options]

Stops and removes the Connector and Codex configuration watcher LaunchAgents.
It does not delete Connector config, durable queues, or the Codex App Server.
Use --reloader-launchd-label when the watcher uses a non-default label.
`,
  emit: `Usage:
  metapi-connector emit --kind hook|notify --agent codex|claude_code [--config PATH] [JSON]

Queues a local agent event durably. JSON may be supplied as an argument or stdin.
`,
  'dispatch-codex-notify': `Usage:
  metapi-connector dispatch-codex-notify --config PATH [--forward-notify JSON_ARGV] [JSON]

Internal Codex notify dispatcher. It enriches completion events with the locally
known session title and optionally forwards to an existing notify command.
`,
  'reload-codex-runtime': `Usage:
  metapi-connector reload-codex-runtime --codex-executable PATH \\
    --connector-launchd-label LABEL --app-server-socket PATH \\
    [--connector-health-url URL] [--debounce-ms MS]

Restarts the managed Codex App Server so auth.json/config.toml changes take effect,
then restarts the Connector LaunchAgent and verifies its optional health URL.
`,
  'watch-codex-runtime': `Usage:
  metapi-connector watch-codex-runtime --codex-home PATH \\
    --codex-executable PATH --connector-launchd-label LABEL \\
    --app-server-socket PATH [--connector-health-url URL]

Watches auth.json and config.toml fingerprints and performs the same safe reload
sequence after an atomic configuration change.
`,
};

function parseCli(argv: string[]) {
  return parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      'pairing-id': { type: 'string' },
      'pairing-token': { type: 'string' },
      config: { type: 'string' },
      'poll-interval': { type: 'string' },
      'app-server-endpoint': { type: 'string' },
      'observe-app-server': { type: 'boolean' },
      'control-app-server': { type: 'boolean' },
      direct: { type: 'boolean' },
      'owned-app-server': { type: 'string' },
      'dashboard-host': { type: 'string' },
      'dashboard-port': { type: 'string' },
      'no-dashboard': { type: 'boolean' },
      'codex-executable': { type: 'string' },
      'connector-launchd-label': { type: 'string' },
      'reloader-launchd-label': { type: 'string' },
      'app-server-socket': { type: 'string' },
      'connector-health-url': { type: 'string' },
      'debounce-ms': { type: 'string' },
      'codex-home': { type: 'string' },
      'watch-interval-ms': { type: 'string' },
      'service-timeout-ms': { type: 'string' },
      'no-config-watcher': { type: 'boolean' },
      once: { type: 'boolean' },
      force: { type: 'boolean' },
      kind: { type: 'string' },
      agent: { type: 'string' },
      source: { type: 'string' },
      'forward-notify': { type: 'string' },
      open: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

async function reloadCodex(values: Record<string, unknown>): Promise<void> {
  const result = await reloadCodexRuntime(await codexReloadOptions(values));
  process.stdout.write(`${JSON.stringify({
    success: true,
    reloadedAt: new Date().toISOString(),
    ...result,
  }, null, 2)}\n`);
}

async function codexReloadOptions(values: Record<string, unknown>) {
  const debounceMs = values['debounce-ms'] === undefined
    ? undefined
    : Number(values['debounce-ms']);
  if (debounceMs !== undefined
    && (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 30_000)) {
    throw new Error('--debounce-ms 必须在 0 到 30000 毫秒之间');
  }
  const connectorHealthUrl = typeof values['connector-health-url'] === 'string'
    ? values['connector-health-url']
    : null;
  let connectorHealthCheck: (() => Promise<boolean>) | undefined;
  if (!connectorHealthUrl && typeof values.config === 'string' && values.config.trim()) {
    const configPath = resolveLocalConnectorConfigPath(values.config);
    const config = await loadLocalConnectorConfig(configPath);
    connectorHealthCheck = async () => {
      const local = await inspectConnectorRuntimeState(config.dataDir);
      const inspection = await inspectLocalConnectorDashboard(config.dataDir, local.pid);
      return inspection.reachable && inspection.runtimeVersion === CONNECTOR_VERSION;
    };
  }
  return {
    codexExecutable: required(values['codex-executable'], '--codex-executable'),
    connectorLaunchdLabel: required(values['connector-launchd-label'], '--connector-launchd-label'),
    appServerSocketPath: required(values['app-server-socket'], '--app-server-socket'),
    connectorHealthUrl,
    connectorHealthCheck,
    debounceMs,
  };
}

async function watchCodex(values: Record<string, unknown>): Promise<void> {
  const codexHome = required(values['codex-home'], '--codex-home').replace(/\/+$/, '');
  const pollIntervalMs = values['watch-interval-ms'] === undefined
    ? undefined
    : Number(values['watch-interval-ms']);
  if (pollIntervalMs !== undefined
    && (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000)) {
    throw new Error('--watch-interval-ms 必须在 250 到 60000 毫秒之间');
  }
  const controller = new AbortController();
  const reloadOptions = await codexReloadOptions(values);
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`[metapi-connector] Watching Codex config in ${codexHome}\n`);
  try {
    await watchCodexRuntimeConfig({
      configPaths: [`${codexHome}/auth.json`, `${codexHome}/config.toml`],
      reloadOptions,
      pollIntervalMs,
      signal: controller.signal,
      onReload: ({ changedAt, result }) => {
        process.stdout.write(`${JSON.stringify({ event: 'codex_runtime_reloaded', changedAt, ...result })}\n`);
      },
      onError: (error) => {
        process.stderr.write(`[metapi-connector] Codex runtime reload failed: ${error.message}\n`);
      },
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function required(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`缺少 ${label}`);
  return normalized;
}

function connectorLaunchCommand() {
  return {
    executable: process.execPath,
    argv: [fileURLToPath(import.meta.url)],
  };
}

async function readStdin(maxBytes = 128 * 1024): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error('Hook/Notify payload 超过本地限制');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function pair(values: Record<string, unknown>): Promise<void> {
  const configPath = resolveLocalConnectorConfigPath(values.config as string | undefined);
  const existing = await readOptionalFile(configPath, 128 * 1024);
  if (existing.exists && values.force !== true) {
    throw new Error(`Connector 配置已存在: ${configPath}；请先在 WebUI 撤销旧设备，或显式使用 --force`);
  }
  const previousConfig = existing.exists ? await loadLocalConnectorConfig(configPath) : null;
  const pollInterval = values['poll-interval'] === undefined
    ? undefined
    : Number(values['poll-interval']);
  if (pollInterval !== undefined
    && (!Number.isFinite(pollInterval) || pollInterval < 500 || pollInterval > 60_000)) {
    throw new Error('--poll-interval 必须在 500 到 60000 毫秒之间');
  }
  const serverUrl = required(values.server, '--server');
  const client = new LocalConnectorClient(serverUrl, null);
  const claimed = await client.claimPairing({
    pairingId: required(values['pairing-id'], '--pairing-id'),
    pairingToken: required(values['pairing-token'], '--pairing-token'),
    platform: `${process.platform}-${process.arch}`,
    version: CONNECTOR_VERSION,
    capabilities: [...LOCAL_CONNECTOR_CAPABILITIES],
  });
  const config = createLocalConnectorConfig({
    serverUrl,
    deviceId: claimed.deviceId,
    connectorToken: claimed.connectorToken,
    configPath,
    pollIntervalMs: pollInterval,
    appServerEndpoint: typeof values['app-server-endpoint'] === 'string'
      ? values['app-server-endpoint']
      : undefined,
    previousConfig,
  });
  await saveLocalConnectorConfig(configPath, config);
  process.stdout.write(`${JSON.stringify({ success: true, deviceId: config.deviceId, configPath }, null, 2)}\n`);
}

async function status(values: Record<string, unknown>): Promise<void> {
  process.stdout.write(`${JSON.stringify(await connectorStatusReport(values), null, 2)}\n`);
}

async function connectorStatusReport(values: Record<string, unknown>) {
  const configPath = resolveLocalConnectorConfigPath(values.config as string | undefined);
  const config = await loadLocalConnectorConfig(configPath);
  const client = new LocalConnectorClient(config.serverUrl, config.connectorToken);
  const local = await inspectConnectorRuntimeState(config.dataDir, {
    serviceLabel: typeof values['connector-launchd-label'] === 'string'
      ? values['connector-launchd-label']
      : null,
  });
  const dashboard = await inspectLocalConnectorDashboard(config.dataDir, local.pid);
  let heartbeat: Record<string, unknown> | null = null;
  let remoteError: string | null = null;
  try {
    // Status is an inspection command. Runtime metadata is owned by the
    // running Connector heartbeat and must not be overwritten by this CLI.
    heartbeat = await client.heartbeat();
  } catch (error) {
    remoteError = error instanceof Error ? error.message : String(error);
  }
  return {
    success: true,
    version: CONNECTOR_VERSION,
    cliVersion: CONNECTOR_VERSION,
    runtimeVersion: dashboard.runtimeVersion,
    configPath,
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    device: heartbeat?.device || null,
    serverTime: heartbeat?.serverTime || null,
    remote: {
      reachable: heartbeat !== null,
      error: remoteError,
    },
    local,
    dashboard,
  };
}

type DoctorCheck = Readonly<{
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}>;

async function doctor(values: Record<string, unknown>): Promise<void> {
  const result = await connectorDoctorReport(values);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.readyForSessionControl) process.exitCode = 1;
}

async function connectorDoctorReport(values: Record<string, unknown>) {
  const report = await connectorStatusReport(values);
  const checks: DoctorCheck[] = [];
  checks.push({
    id: 'local_process',
    label: 'Connector 本地进程',
    status: report.local.running && report.local.lockStatus === 'active' ? 'pass' : 'fail',
    detail: report.local.running
      ? `pid ${report.local.pid}，运行锁 ${report.local.lockStatus}`
      : `未运行，运行锁 ${report.local.lockStatus}`,
  });
  checks.push({
    id: 'pid_consistency',
    label: '运行锁与 PID 文件',
    status: report.local.pidFileMatchesLock ? 'pass' : 'warn',
    detail: report.local.pidFileMatchesLock
      ? `均指向 pid ${report.local.pid}`
      : `lock=${report.local.pid || '-'} pidFile=${report.local.pidFilePid || '-'}`,
  });
  if (report.local.launchd) {
    checks.push({
      id: 'launchd',
      label: 'launchd 常驻服务',
      status: report.local.launchd.available && report.local.launchd.matchesLock === true ? 'pass' : 'fail',
      detail: report.local.launchd.available
        ? `state=${report.local.launchd.state || '-'} pid=${report.local.launchd.pid || '-'}`
        : `未找到 ${report.local.serviceLabel || 'Connector LaunchAgent'}`,
    });
  }
  checks.push({
    id: 'dashboard',
    label: '本地 Connector 看板',
    status: report.dashboard.reachable ? 'pass' : 'fail',
    detail: report.dashboard.reachable
      ? report.dashboard.url || '本地看板可达'
      : report.dashboard.error || '运行实例未发布看板地址',
  });
  checks.push({
    id: 'runtime_version',
    label: 'CLI 与常驻运行版本',
    status: report.dashboard.runtimeVersion === CONNECTOR_VERSION ? 'pass' : 'fail',
    detail: `cli=${CONNECTOR_VERSION} runtime=${report.dashboard.runtimeVersion || '未知'}`,
  });
  const appServer = report.dashboard.snapshot?.appServer;
  checks.push({
    id: 'app_server',
    label: 'Codex App Server 控制链路',
    status: appServer?.mode === 'control' && appServer.status === 'connected' ? 'pass' : 'fail',
    detail: appServer
      ? `${appServer.mode} / ${appServer.status}${appServer.lastError ? ` · ${appServer.lastError}` : ''}`
      : '无法从本地看板读取 App Server 状态',
  });
  checks.push({
    id: 'thread_snapshot',
    label: '会话快照上报',
    status: report.dashboard.snapshot?.threadSnapshotSyncStatus === 'supported' ? 'pass' : 'fail',
    detail: report.dashboard.snapshot?.threadSnapshotSyncStatus || '未知',
  });
  checks.push({
    id: 'remote',
    label: 'r-api 线上心跳',
    status: report.remote.reachable ? 'pass' : 'fail',
    detail: report.remote.reachable ? report.serverUrl : report.remote.error || '不可达',
  });
  const readyForSessionControl = checks
    .filter((check) => check.id !== 'pid_consistency')
    .every((check) => check.status === 'pass');
  return {
    success: readyForSessionControl,
    version: CONNECTOR_VERSION,
    readyForSessionControl,
    dashboardUrl: report.dashboard.url,
    checks,
  };
}

function serviceTimeout(values: Record<string, unknown>): number {
  const timeout = values['service-timeout-ms'] === undefined
    ? 30_000
    : Number(values['service-timeout-ms']);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error('--service-timeout-ms 必须在 1000 到 120000 毫秒之间');
  }
  return timeout;
}

async function installService(values: Record<string, unknown>): Promise<void> {
  const configPath = resolveLocalConnectorConfigPath(values.config as string | undefined);
  const config = await loadLocalConnectorConfig(configPath);
  const connectorLabel = required(values['connector-launchd-label'], '--connector-launchd-label');
  const codexHome = typeof values['codex-home'] === 'string' && values['codex-home'].trim()
    ? values['codex-home'].trim()
    : process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const codexExecutable = typeof values['codex-executable'] === 'string' && values['codex-executable'].trim()
    ? values['codex-executable'].trim()
    : join(codexHome, 'packages', 'standalone', 'current', 'codex');
  const appServerSocketPath = typeof values['app-server-socket'] === 'string' && values['app-server-socket'].trim()
    ? values['app-server-socket'].trim()
    : join(codexHome, 'app-server-control', 'app-server-control.sock');
  const dashboardPort = values['dashboard-port'] === undefined ? 4_765 : Number(values['dashboard-port']);
  const deadline = Date.now() + serviceTimeout(values);
  let readiness: Awaited<ReturnType<typeof connectorDoctorReport>> | null = null;
  const service = await installLocalConnectorServices({
    configPath,
    config,
    connectorLabel,
    reloaderLabel: typeof values['reloader-launchd-label'] === 'string'
      ? values['reloader-launchd-label']
      : undefined,
    installConfigWatcher: values['no-config-watcher'] !== true,
    nodeExecutable: process.execPath,
    cliEntryPath: fileURLToPath(import.meta.url),
    codexHome,
    codexExecutable,
    appServerSocketPath,
    dashboardHost: typeof values['dashboard-host'] === 'string' ? values['dashboard-host'] : undefined,
    dashboardPort,
    pathEnvironment: process.env.PATH,
    verify: async () => {
      do {
        readiness = await connectorDoctorReport({
          config: configPath,
          'connector-launchd-label': connectorLabel,
        });
        if (readiness.readyForSessionControl) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      } while (Date.now() < deadline);
      throw new Error(`Connector service health verification failed: ${JSON.stringify(readiness?.checks || [])}`);
    },
  });
  readiness ||= await connectorDoctorReport({
      config: configPath,
      'connector-launchd-label': connectorLabel,
    });
  process.stdout.write(`${JSON.stringify({
    success: true,
    version: CONNECTOR_VERSION,
    service,
    readiness,
  }, null, 2)}\n`);
}

async function uninstallService(values: Record<string, unknown>): Promise<void> {
  const connectorLabel = required(values['connector-launchd-label'], '--connector-launchd-label');
  const result = await uninstallLocalConnectorServices({
    connectorLabel,
    reloaderLabel: typeof values['reloader-launchd-label'] === 'string'
      ? values['reloader-launchd-label']
      : undefined,
  });
  process.stdout.write(`${JSON.stringify({ success: true, ...result }, null, 2)}\n`);
}

async function dashboard(values: Record<string, unknown>): Promise<void> {
  const configPath = resolveLocalConnectorConfigPath(values.config as string | undefined);
  const config = await loadLocalConnectorConfig(configPath);
  const local = await inspectConnectorRuntimeState(config.dataDir);
  const inspection = await inspectLocalConnectorDashboard(config.dataDir, local.pid);
  if (!inspection.available || !inspection.url) {
    throw new Error(inspection.error || 'Connector 未发布本地看板地址；请确认 run 未使用 --no-dashboard');
  }
  if (!inspection.reachable) throw new Error(inspection.error || `本地看板不可达: ${inspection.url}`);
  if (values.open === true) {
    if (process.platform !== 'darwin') throw new Error('--open 当前仅支持 macOS');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/open', [inspection.url!], { shell: false, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`/usr/bin/open 退出码 ${code}`)));
    });
  }
  process.stdout.write(`${JSON.stringify({
    success: true,
    opened: values.open === true,
    url: inspection.url,
    urls: inspection.urls,
    healthUrl: inspection.healthUrl,
    statusUrl: inspection.statusUrl,
    snapshot: inspection.snapshot,
  }, null, 2)}\n`);
}

async function emit(
  values: Record<string, unknown>,
  payloadArg: string | undefined,
): Promise<void> {
  const kind = values.kind === 'hook' || values.kind === 'notify' ? values.kind : null;
  if (!kind) throw new Error('--kind 必须是 hook 或 notify');
  const agent: LocalConnectorAgent | null = values.agent === 'codex' || values.agent === 'claude_code'
    ? values.agent
    : null;
  if (!agent) throw new Error('--agent 必须是 codex 或 claude_code');
  const configPath = resolveLocalConnectorConfigPath(values.config as string | undefined);
  const config = await loadLocalConnectorConfig(configPath);
  const rawPayload = payloadArg ?? await readStdin();
  // Codex's Stop hook is the native end-of-turn signal. Promote only this
  // hook to the notification lane so existing SessionStart/SessionEnd and
  // Computer Use notify configuration remain untouched.
  const effectiveKind = kind === 'hook' && agent === 'codex' && isCodexTurnCompletionHook(rawPayload)
    ? 'notify'
    : kind;
  const event = normalizeLocalAgentEvent({ rawPayload, kind: effectiveKind, agent });
  await enqueueLocalConnectorEvent({ dataDir: config.dataDir, ...event });
}

function parseForwardNotify(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--forward-notify 必须是 JSON argv 数组');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new Error('--forward-notify 必须是非空 JSON argv 数组');
  }
  const argv = parsed.map((item) => {
    if (typeof item !== 'string' || !item || item.length > 4_096 || item.includes('\0')) {
      throw new Error('--forward-notify 包含无效参数');
    }
    return item;
  });
  return argv;
}

export async function dispatchCodexNotify(
  values: Record<string, unknown>,
  payloadArg: string | undefined,
): Promise<void> {
  const configPath = resolveLocalConnectorConfigPath(values.config as string | undefined);
  const config = await loadLocalConnectorConfig(configPath);
  const rawPayload = payloadArg ?? await readStdin();
  const threadTitle = await readLocalConnectorThreadTitle(
    config.dataDir,
    localAgentEventThreadId(rawPayload),
  );
  const event = normalizeLocalAgentEvent({
    rawPayload,
    kind: 'notify',
    agent: 'codex',
    threadTitle,
  });
  await enqueueLocalConnectorEvent({ dataDir: config.dataDir, ...event });

  const forward = parseForwardNotify(values['forward-notify']);
  if (!forward) return;
  const child = spawn(forward[0]!, [...forward.slice(1), rawPayload], {
    detached: true,
    shell: false,
    stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}

async function run(values: Record<string, unknown>): Promise<void> {
  const configPath = resolveLocalConnectorConfigPath(values.config as string | undefined);
  const config = await loadLocalConnectorConfig(configPath);
  const entryPath = fileURLToPath(import.meta.url);
  if (entryPath.endsWith('.ts')) {
    process.stderr.write('提示：当前是 tsx 开发入口；实际安装 Hook/Notify 前请先运行 npm run build:server 并使用编译后的 Connector。\n');
  }
  const runtime = new LocalConnectorRuntime(config, configPath, connectorLaunchCommand());
  if (values.once === true) {
    const result = await runtime.runOnce();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const controller = new AbortController();
  const dashboardPort = values['dashboard-port'] === undefined
    ? undefined
    : Number(values['dashboard-port']);
  if (dashboardPort !== undefined
    && (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65_535)) {
    throw new Error('--dashboard-port 必须在 1 到 65535 之间');
  }
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`[metapi-connector] Starting version=${CONNECTOR_VERSION} pid=${process.pid} config=${configPath}\n`);
  try {
    const direct = values.direct === true;
    await runtime.run({
      signal: controller.signal,
      observeAppServer: values['observe-app-server'] === true && !direct,
      controlAppServer: direct || values['control-app-server'] === true,
      ownedAppServerExecutable: typeof values['owned-app-server'] === 'string'
        ? values['owned-app-server']
        : null,
      dashboard: values['no-dashboard'] !== true,
      dashboardHost: typeof values['dashboard-host'] === 'string'
        ? values['dashboard-host']
        : undefined,
      dashboardPort,
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export async function runLocalConnectorCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCli(argv);
  if (parsed.values.version) {
    process.stdout.write(`${CONNECTOR_VERSION}\n`);
    return;
  }
  const command = parsed.positionals[0];
  if (parsed.values.help || !command) {
    process.stdout.write(command && COMMAND_HELP[command] ? COMMAND_HELP[command] : HELP);
    return;
  }
  if (command === 'pair') return pair(parsed.values);
  if (command === 'status') return status(parsed.values);
  if (command === 'doctor') return doctor(parsed.values);
  if (command === 'dashboard') return dashboard(parsed.values);
  if (command === 'install-service') return installService(parsed.values);
  if (command === 'uninstall-service') return uninstallService(parsed.values);
  if (command === 'emit') return emit(parsed.values, parsed.positionals[1]);
  if (command === 'dispatch-codex-notify') {
    return dispatchCodexNotify(parsed.values, parsed.positionals[1]);
  }
  if (command === 'run') return run(parsed.values);
  if (command === 'reload-codex-runtime') return reloadCodex(parsed.values);
  if (command === 'watch-codex-runtime') return watchCodex(parsed.values);
  throw new Error(`未知 Connector 命令: ${command}`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

const isMain = isMainModule();
if (isMain) {
  runLocalConnectorCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
