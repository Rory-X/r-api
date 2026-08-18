import { spawnSync } from 'node:child_process';

const LOCAL_LISTENER_OVERRIDE_ENV = 'METAPI_TEST_LOCAL_LISTENER';
const LOCAL_LISTENER_PROBE = String.raw`
const { createServer } = require('node:net');
const server = createServer();
const timer = setTimeout(() => process.exit(2), 1500);
timer.unref();
server.once('error', () => process.exit(1));
server.listen(0, '127.0.0.1', () => {
  server.close((error) => process.exit(error ? 1 : 0));
});
`;

let cachedCapability: boolean | undefined;

export function parseLocalListenerOverride(value: string | undefined): boolean | null {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}
export function canBindLocalTestListener(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = parseLocalListenerOverride(env[LOCAL_LISTENER_OVERRIDE_ENV]);
  if (override !== null) return override;
  if (cachedCapability !== undefined) return cachedCapability;

  const result = spawnSync(process.execPath, ['-e', LOCAL_LISTENER_PROBE], {
    stdio: 'ignore',
    timeout: 3_000,
  });
  cachedCapability = result.status === 0 && !result.error;
  return cachedCapability;
}
