import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFile, readOptionalFile } from './atomicFile.js';

export const LOCAL_CONNECTOR_CONFIG_PROTOCOL = 'metapi.local-connector.config.v1' as const;

export type LocalConnectorConfig = {
  protocol: typeof LOCAL_CONNECTOR_CONFIG_PROTOCOL;
  serverUrl: string;
  deviceId: string;
  connectorToken: string;
  backupKey: string;
  pairedAt: string;
  pollIntervalMs: number;
  dataDir: string;
  appServerEndpoint?: string | null;
};

function normalizeText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function normalizeConnectorServerUrl(value: unknown): string {
  const raw = normalizeText(value, '服务器 URL', 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('服务器 URL 格式无效');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('服务器 URL 只支持 HTTP(S)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('服务器 URL 不能包含凭据、查询参数或片段');
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('非本机 Connector 服务器必须使用 HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function defaultLocalConnectorDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.METAPI_CONNECTOR_HOME?.trim()) return resolve(env.METAPI_CONNECTOR_HOME.trim());
  if (platform() === 'win32') {
    return resolve(env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'Metapi', 'Connector');
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Metapi', 'Connector');
  return resolve(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'metapi', 'connector');
}

export function resolveLocalConnectorConfigPath(input?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = input?.trim() || env.METAPI_CONNECTOR_CONFIG?.trim();
  return candidate ? resolve(candidate) : join(defaultLocalConnectorDataDir(env), 'config.json');
}

function normalizeBackupKey(value: unknown): string {
  const key = normalizeText(value, '本地备份密钥', 128);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(key, 'base64url');
  } catch {
    throw new Error('本地备份密钥无效');
  }
  if (decoded.byteLength !== 32) throw new Error('本地备份密钥无效');
  return key;
}

export function normalizeLocalConnectorConfig(value: unknown): LocalConnectorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connector 配置无效');
  const raw = value as Record<string, unknown>;
  if (raw.protocol !== LOCAL_CONNECTOR_CONFIG_PROTOCOL) throw new Error('Connector 配置协议不受支持');
  const pollIntervalMs = Math.trunc(Number(raw.pollIntervalMs));
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 500 || pollIntervalMs > 60_000) {
    throw new Error('Connector 轮询间隔必须在 500 到 60000 毫秒之间');
  }
  const dataDir = resolve(normalizeText(raw.dataDir, 'Connector 数据目录', 4_096));
  const endpoint = typeof raw.appServerEndpoint === 'string' && raw.appServerEndpoint.trim()
    ? normalizeText(raw.appServerEndpoint, 'App Server Endpoint', 4_096)
    : null;
  return {
    protocol: LOCAL_CONNECTOR_CONFIG_PROTOCOL,
    serverUrl: normalizeConnectorServerUrl(raw.serverUrl),
    deviceId: normalizeText(raw.deviceId, '设备 ID', 128),
    connectorToken: normalizeText(raw.connectorToken, '设备令牌', 512),
    backupKey: normalizeBackupKey(raw.backupKey),
    pairedAt: normalizeText(raw.pairedAt, '配对时间', 80),
    pollIntervalMs,
    dataDir,
    appServerEndpoint: endpoint,
  };
}

export async function loadLocalConnectorConfig(path: string): Promise<LocalConnectorConfig> {
  const snapshot = await readOptionalFile(path, 128 * 1024);
  if (!snapshot.exists) throw new Error(`Connector 配置不存在: ${path}`);
  try {
    return normalizeLocalConnectorConfig(JSON.parse(snapshot.data.toString('utf8')));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Connector 配置 JSON 损坏: ${path}`);
    throw error;
  }
}

export async function saveLocalConnectorConfig(path: string, config: LocalConnectorConfig): Promise<void> {
  const normalized = normalizeLocalConnectorConfig(config);
  await atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
}

export function createLocalConnectorConfig(input: {
  serverUrl: string;
  deviceId: string;
  connectorToken: string;
  configPath: string;
  pollIntervalMs?: number;
  appServerEndpoint?: string | null;
  previousConfig?: LocalConnectorConfig | null;
}): LocalConnectorConfig {
  const dataDir = input.previousConfig?.dataDir || dirname(resolve(input.configPath));
  return normalizeLocalConnectorConfig({
    protocol: LOCAL_CONNECTOR_CONFIG_PROTOCOL,
    serverUrl: input.serverUrl,
    deviceId: input.deviceId,
    connectorToken: input.connectorToken,
    backupKey: input.previousConfig?.backupKey || randomBytes(32).toString('base64url'),
    pairedAt: new Date().toISOString(),
    pollIntervalMs: input.pollIntervalMs ?? input.previousConfig?.pollIntervalMs ?? 2_000,
    dataDir,
    appServerEndpoint: input.appServerEndpoint === undefined
      ? input.previousConfig?.appServerEndpoint || null
      : input.appServerEndpoint || null,
  });
}
