export const CONNECTOR_VERSION = '1.0.4';

export const CODEX_DESKTOP_APP_SERVER_CLIENT_INFO = Object.freeze({
  name: 'codex-desktop',
  title: 'Codex Desktop',
  version: CONNECTOR_VERSION,
} as const);

export const LOCAL_CONNECTOR_CAPABILITIES = Object.freeze([
  'action-driver-v1',
  'encrypted-backup-v1',
  'durable-event-queue-v1',
  'durable-bridge-queue-v1',
  'app-server-observer-v1',
  'app-server-control-v1',
  'local-dashboard-v1',
  'codex-notify-health-v1',
] as const);
