import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { executeLocalConnectorAction } from './actionDriver.js';
import type { LocalConnectorActionManifest } from './protocol.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metapi-connector-'));
  roots.push(root);
  return root;
}

function manifest(input: Partial<LocalConnectorActionManifest> = {}): LocalConnectorActionManifest {
  return {
    protocol: 'metapi.local-connector.action.v1',
    actionId: 'action-1',
    kind: 'hook',
    operation: 'install',
    agent: 'codex',
    requiresBackup: true,
    backupRef: null,
    eventNames: ['SessionStart', 'Stop'],
    endpoints: {
      events: '/api/local-connector/public/events',
      browserRecoveryClaim: '/api/browser-credential-tasks/public/claim',
      browserRecoveryComplete: '/api/browser-credential-tasks/public/complete',
    },
    createdAt: '2026-08-04T00:00:00.000Z',
    ...input,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local connector action driver', () => {
  it('preserves existing hooks, encrypts the backup, and restores exact bytes', async () => {
    const root = await tempRoot();
    const codexHome = join(root, 'codex');
    const claudeConfigDir = join(root, 'claude');
    const target = join(codexHome, 'hooks.json');
    await mkdir(codexHome, { recursive: true });
    await writeFile(target, '{"description":"sentinel-secret","hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing"}]}]}}\n');
    const backupKey = randomBytes(32).toString('base64url');
    const options = {
      dataDir: join(root, 'data'),
      backupKey,
      configPath: join(root, 'data', 'config.json'),
      launch: { executable: '/usr/bin/node', argv: ['/opt/metapi/connector.js'] },
      paths: { codexHome, claudeConfigDir },
    };

    const installed = await executeLocalConnectorAction(manifest(), options);
    expect(installed.changed).toBe(true);
    expect(installed.backupRef).toMatch(/^lcb_/);
    const document = JSON.parse(await readFile(target, 'utf8'));
    expect(document.hooks.Stop).toHaveLength(2);
    expect(document.hooks.SessionStart[0].hooks[0].command).toContain('metapi-local-connector');

    const encrypted = await readFile(join(root, 'data', 'backups', `${installed.backupRef}.json`), 'utf8');
    expect(encrypted).not.toContain('sentinel-secret');

    await executeLocalConnectorAction(manifest({
      operation: 'rollback',
      requiresBackup: false,
      backupRef: installed.backupRef,
    }), options);
    expect(await readFile(target, 'utf8')).toBe('{"description":"sentinel-secret","hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing"}]}]}}\n');
  });

  it('installs Codex notify as argv TOML and rejects a backup from another target', async () => {
    const root = await tempRoot();
    const codexHome = join(root, 'codex');
    const claudeConfigDir = join(root, 'claude');
    const target = join(codexHome, 'config.toml');
    await mkdir(codexHome, { recursive: true });
    const computerUse = ['/Applications/SkyComputerUseClient', 'turn-ended'];
    const oldManaged = [
      '/old/node',
      '/old/connector.js',
      'emit',
      '--kind',
      'notify',
      '--agent',
      'codex',
      '--source',
      'metapi-local-connector',
    ];
    await writeFile(target, [
      'model = "gpt-test"',
      `notify = ${JSON.stringify([...computerUse, '--previous-notify', JSON.stringify(oldManaged)])}`,
      '',
    ].join('\n'));
    const options = {
      dataDir: join(root, 'data'),
      backupKey: randomBytes(32).toString('base64url'),
      configPath: join(root, 'data', 'config.json'),
      launch: { executable: '/usr/bin/node', argv: ['/opt/metapi/connector.js'] },
      paths: { codexHome, claudeConfigDir },
    };
    const installed = await executeLocalConnectorAction(manifest({ kind: 'notify', eventNames: [] }), options);
    const parsed = parseToml(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-test');
    expect(parsed.notify).toEqual([
      '/usr/bin/node',
      '/opt/metapi/connector.js',
      'dispatch-codex-notify',
      '--config',
      options.configPath,
      '--source',
      'metapi-local-connector',
      '--forward-notify',
      JSON.stringify(computerUse),
    ]);

    await executeLocalConnectorAction(manifest({ kind: 'notify', eventNames: [] }), options);
    const reinstalled = parseToml(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(reinstalled.notify).toEqual(parsed.notify);

    await executeLocalConnectorAction(manifest({
      kind: 'notify',
      operation: 'uninstall',
      eventNames: [],
    }), {
      ...options,
      launch: { executable: '/new/location/node', argv: ['/new/location/connector.js'] },
    });
    expect((parseToml(await readFile(target, 'utf8')) as Record<string, unknown>).notify).toBeUndefined();

    await executeLocalConnectorAction(manifest({ kind: 'notify', eventNames: [] }), options);

    await expect(executeLocalConnectorAction(manifest({
      kind: 'hook',
      operation: 'rollback',
      requiresBackup: false,
      backupRef: installed.backupRef,
    }), options)).rejects.toThrow('不匹配');
  });

  it('adds and removes only the managed Claude notification hook', async () => {
    const root = await tempRoot();
    const codexHome = join(root, 'codex');
    const claudeConfigDir = join(root, 'claude');
    const target = join(claudeConfigDir, 'settings.json');
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(target, JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'command', command: 'existing' }] }] } }));
    const options = {
      dataDir: join(root, 'data'),
      backupKey: randomBytes(32).toString('base64url'),
      configPath: join(root, 'data', 'config.json'),
      launch: { executable: 'node', argv: ['connector.js'] },
      paths: { codexHome, claudeConfigDir },
    };
    await executeLocalConnectorAction(manifest({ agent: 'claude_code', kind: 'notify', eventNames: [] }), options);
    let document = JSON.parse(await readFile(target, 'utf8'));
    expect(document.hooks.Notification).toHaveLength(2);

    await executeLocalConnectorAction(manifest({
      agent: 'claude_code',
      kind: 'notify',
      operation: 'uninstall',
      eventNames: [],
    }), options);
    document = JSON.parse(await readFile(target, 'utf8'));
    expect(document.hooks.Notification).toEqual([{ hooks: [{ type: 'command', command: 'existing' }] }]);
  });
});
