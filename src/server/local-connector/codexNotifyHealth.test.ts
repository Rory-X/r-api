import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexNotifyArgv, type LocalConnectorLaunchCommand } from './actionDriver.js';
import { inspectCodexNotifyHealth } from './codexNotifyHealth.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metapi-codex-notify-health-'));
  roots.push(root);
  const targetPath = join(root, 'config.toml');
  const configPath = join(root, 'connector.json');
  const cliPath = join(root, 'cli.js');
  await writeFile(cliPath, 'export {};\n');
  const launch: LocalConnectorLaunchCommand = { executable: process.execPath, argv: [cliPath] };
  const writeNotify = async (notify: string[]) => {
    await writeFile(targetPath, stringifyToml({ notify }));
  };
  return { targetPath, configPath, launch, writeNotify };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('inspectCodexNotifyHealth', () => {
  it('accepts the managed dispatcher with an optional forward command', async () => {
    const test = await fixture();
    await test.writeNotify([
      test.launch.executable,
      ...buildCodexNotifyArgv(test.launch, test.configPath, ['/tmp/forward', 'turn-ended']),
    ]);

    await expect(inspectCodexNotifyHealth({
      ...test,
      now: () => new Date('2026-08-14T08:00:00.000Z'),
    })).resolves.toEqual({
      checkId: 'codex_notify',
      status: 'healthy',
      reason: null,
      observedAt: '2026-08-14T08:00:00.000Z',
    });
  });

  it('reports when another application overwrites the managed wrapper', async () => {
    const test = await fixture();
    await test.writeNotify(['/tmp/SkyComputerUseClient', 'turn-ended']);

    await expect(inspectCodexNotifyHealth(test)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'managed_wrapper_missing',
    });
  });

  it('rejects a managed command that points at a different runtime', async () => {
    const test = await fixture();
    await test.writeNotify([
      process.execPath,
      '/tmp/old-cli.js',
      'dispatch-codex-notify',
      '--config',
      test.configPath,
      '--source',
      'metapi-local-connector',
    ]);

    await expect(inspectCodexNotifyHealth(test)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'managed_command_mismatch',
    });
  });

  it('rejects an invalid forward command', async () => {
    const test = await fixture();
    await test.writeNotify([
      test.launch.executable,
      ...buildCodexNotifyArgv(test.launch, test.configPath),
      '--forward-notify',
      '{not-json}',
    ]);

    await expect(inspectCodexNotifyHealth(test)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'forward_notify_invalid',
    });
  });
});
