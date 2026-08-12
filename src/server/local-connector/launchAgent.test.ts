import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveLocalConnectorConfig, type LocalConnectorConfig } from './config.js';
import {
  installLocalConnectorServices,
  renderLaunchAgentPlist,
  uninstallLocalConnectorServices,
} from './launchAgent.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'metapi-launch-agent-'));
  roots.push(root);
  const home = join(root, 'home');
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  const dataDir = join(root, 'connector-data');
  const configPath = join(dataDir, 'config.json');
  const nodeExecutable = join(root, 'node');
  const packageRoot = join(root, 'global', 'metapi-connector');
  const cliEntryPath = join(packageRoot, 'dist', 'cli.js');
  const codexHome = join(home, '.codex');
  const codexExecutable = join(codexHome, 'packages', 'standalone', 'current', 'codex');
  const appServerSocketPath = join(codexHome, 'app-server-control', 'app-server-control.sock');
  const config: LocalConnectorConfig = {
    protocol: 'metapi.local-connector.config.v1',
    serverUrl: 'https://metapi.example.com',
    deviceId: 'device-service',
    connectorToken: 'lc_test_connector_token_abcdefghijklmnopqrstuvwxyz',
    backupKey: Buffer.alloc(32).toString('base64url'),
    pairedAt: '2026-08-12T00:00:00.000Z',
    pollIntervalMs: 2_000,
    dataDir,
    appServerEndpoint: null,
  };
  await saveLocalConnectorConfig(configPath, config);
  await Promise.all([
    mkdir(dirname(nodeExecutable), { recursive: true }),
    mkdir(dirname(codexExecutable), { recursive: true }),
    mkdir(dirname(cliEntryPath), { recursive: true }),
    mkdir(launchAgentsDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(nodeExecutable, '#!/bin/sh\n', { mode: 0o755 }),
    writeFile(codexExecutable, '#!/bin/sh\n', { mode: 0o755 }),
    writeFile(cliEntryPath, '#!/usr/bin/env node\n', { mode: 0o755 }),
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'metapi-connector', version: '1.0.4' })),
  ]);
  await Promise.all([chmod(nodeExecutable, 0o755), chmod(codexExecutable, 0o755)]);
  return {
    appServerSocketPath,
    cliEntryPath,
    codexExecutable,
    codexHome,
    config,
    configPath,
    dataDir,
    home,
    launchAgentsDir,
    nodeExecutable,
  };
}

describe('local Connector LaunchAgent installer', () => {
  it('renders escaped, deterministic plist data', () => {
    const plist = renderLaunchAgentPlist({
      label: 'com.metapi.connector.test',
      programArguments: ['/opt/node', '/opt/a&b/cli.js', 'run'],
      environment: { PATH: '/opt/bin', HOME: '/Users/A&B' },
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/err.log',
      throttleInterval: 10,
    });
    expect(plist).toContain('<string>/opt/a&amp;b/cli.js</string>');
    expect(plist).toContain('<string>/Users/A&amp;B</string>');
    expect(plist.indexOf('<key>HOME</key>')).toBeLessThan(plist.indexOf('<key>PATH</key>'));
    expect(plist).not.toContain('WorkingDirectory');
  });

  it('backs up existing plists, validates replacements and retries bootstrap', async () => {
    const fixture = await createFixture();
    const connectorLabel = 'com.metapi.connector.test';
    const reloaderLabel = 'com.metapi.connector.test.reloader';
    const connectorPlistPath = join(fixture.launchAgentsDir, `${connectorLabel}.plist`);
    const reloaderPlistPath = join(fixture.launchAgentsDir, `${reloaderLabel}.plist`);
    await Promise.all([
      writeFile(connectorPlistPath, '<plist>old connector</plist>\n'),
      writeFile(reloaderPlistPath, '<plist>old reloader</plist>\n'),
    ]);
    const calls: Array<{ executable: string; argv: readonly string[] }> = [];
    let connectorBootstrapAttempts = 0;
    const execute = vi.fn(async (executable: string, argv: readonly string[]) => {
      calls.push({ executable, argv });
      if (argv[0] === 'bootstrap' && argv[2] === connectorPlistPath) {
        connectorBootstrapAttempts += 1;
        if (connectorBootstrapAttempts === 1) throw new Error('Bootstrap failed: 5: Input/output error');
      }
    });
    const wait = vi.fn(async () => undefined);

    const result = await installLocalConnectorServices({
      ...fixture,
      connectorLabel,
      reloaderLabel,
      dashboardPort: 4_765,
      pathEnvironment: '/opt/node/bin:/usr/bin:/bin',
      uid: 501,
      now: () => new Date('2026-08-12T16:00:00.000Z'),
      execute,
      wait,
      platform: 'darwin',
    });

    expect(result).toMatchObject({
      connectorLabel,
      connectorPlistPath,
      reloaderLabel,
      reloaderPlistPath,
      backupDir: join(fixture.dataDir, 'service-backups', '20260812T160000-000Z'),
      dashboardHealthUrl: 'http://127.0.0.1:4765/healthz',
    });
    await expect(readFile(join(result.backupDir!, `${connectorLabel}.plist`), 'utf8'))
      .resolves.toContain('old connector');
    await expect(readFile(join(result.backupDir!, `${reloaderLabel}.plist`), 'utf8'))
      .resolves.toContain('old reloader');
    const connectorPlist = await readFile(connectorPlistPath, 'utf8');
    const reloaderPlist = await readFile(reloaderPlistPath, 'utf8');
    expect(connectorPlist).toContain(`<string>${fixture.cliEntryPath}</string>`);
    expect(connectorPlist).toContain('<string>--direct</string>');
    expect(connectorPlist).toContain('<string>--dashboard-port</string>');
    expect(connectorPlist).toContain(`<string>${dirname(fixture.nodeExecutable)}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin</string>`);
    expect(connectorPlist).not.toContain('WorkingDirectory');
    expect(reloaderPlist).toContain('<string>watch-codex-runtime</string>');
    expect(reloaderPlist).toContain(`<string>${fixture.configPath}</string>`);
    expect(reloaderPlist).not.toContain('--connector-health-url');
    expect((await stat(connectorPlistPath)).mode & 0o777).toBe(0o644);
    expect((await stat(reloaderPlistPath)).mode & 0o777).toBe(0o644);
    expect(calls.filter((call) => call.argv[0] === 'bootstrap' && call.argv[2] === connectorPlistPath))
      .toHaveLength(2);
    expect(wait).toHaveBeenCalledWith(500);
    expect(calls.filter((call) => call.executable === '/usr/bin/plutil')).toHaveLength(2);
    expect(calls.findIndex((call) => call.executable === '/usr/bin/plutil'))
      .toBeLessThan(calls.findIndex((call) => call.argv[0] === 'bootout'));
  });

  it('rejects a repository CLI before stopping any existing service', async () => {
    const fixture = await createFixture();
    await writeFile(join(dirname(dirname(fixture.cliEntryPath)), 'package.json'), JSON.stringify({ name: 'metapi' }));
    const execute = vi.fn(async () => undefined);

    await expect(installLocalConnectorServices({
      ...fixture,
      connectorLabel: 'com.metapi.connector.test',
      uid: 501,
      execute,
      platform: 'darwin',
    })).rejects.toThrow('独立安装的 metapi-connector npm 包');
    expect(execute).not.toHaveBeenCalled();
  });

  it('restores and reloads previous services when the new Connector cannot bootstrap', async () => {
    const fixture = await createFixture();
    const connectorLabel = 'com.metapi.connector.rollback';
    const reloaderLabel = 'com.metapi.connector.rollback.reloader';
    const connectorPlistPath = join(fixture.launchAgentsDir, `${connectorLabel}.plist`);
    const reloaderPlistPath = join(fixture.launchAgentsDir, `${reloaderLabel}.plist`);
    const oldConnector = '<plist>old connector</plist>\n';
    const oldReloader = '<plist>old reloader</plist>\n';
    await Promise.all([
      writeFile(connectorPlistPath, oldConnector),
      writeFile(reloaderPlistPath, oldReloader),
    ]);
    let newConnectorAttempts = 0;
    let restoredConnectorBootstraps = 0;
    const execute = vi.fn(async (_executable: string, argv: readonly string[]) => {
      if (argv[0] !== 'bootstrap' || argv[2] !== connectorPlistPath) return;
      const contents = await readFile(connectorPlistPath, 'utf8');
      if (contents === oldConnector) {
        restoredConnectorBootstraps += 1;
        return;
      }
      newConnectorAttempts += 1;
      throw new Error('new Connector failed to bootstrap');
    });

    await expect(installLocalConnectorServices({
      ...fixture,
      connectorLabel,
      reloaderLabel,
      uid: 501,
      execute,
      wait: async () => undefined,
      platform: 'darwin',
    })).rejects.toThrow('已恢复安装前 LaunchAgent 状态');

    expect(newConnectorAttempts).toBe(3);
    expect(restoredConnectorBootstraps).toBe(1);
    await expect(readFile(connectorPlistPath, 'utf8')).resolves.toBe(oldConnector);
    await expect(readFile(reloaderPlistPath, 'utf8')).resolves.toBe(oldReloader);
  });

  it('rolls back services when post-bootstrap health verification fails', async () => {
    const fixture = await createFixture();
    const connectorLabel = 'com.metapi.connector.unhealthy';
    const connectorPlistPath = join(fixture.launchAgentsDir, `${connectorLabel}.plist`);
    const oldConnector = '<plist>old healthy connector</plist>\n';
    await writeFile(connectorPlistPath, oldConnector);
    let restoredConnectorBootstraps = 0;
    const execute = vi.fn(async (_executable: string, argv: readonly string[]) => {
      if (argv[0] !== 'bootstrap' || argv[2] !== connectorPlistPath) return;
      if (await readFile(connectorPlistPath, 'utf8') === oldConnector) restoredConnectorBootstraps += 1;
    });

    await expect(installLocalConnectorServices({
      ...fixture,
      connectorLabel,
      installConfigWatcher: false,
      uid: 501,
      execute,
      verify: async () => { throw new Error('session control is not ready'); },
      platform: 'darwin',
    })).rejects.toThrow('已恢复安装前 LaunchAgent 状态');

    expect(restoredConnectorBootstraps).toBe(1);
    await expect(readFile(connectorPlistPath, 'utf8')).resolves.toBe(oldConnector);
  });

  it('rejects dashboard port zero instead of silently using the default', async () => {
    const fixture = await createFixture();
    const execute = vi.fn(async () => undefined);
    await expect(installLocalConnectorServices({
      ...fixture,
      connectorLabel: 'com.metapi.connector.invalid-port',
      dashboardPort: 0,
      uid: 501,
      execute,
      platform: 'darwin',
    })).rejects.toThrow('Dashboard 端口必须在 1 到 65535 之间');
    expect(execute).not.toHaveBeenCalled();
  });

  it('unloads and removes only service plist files', async () => {
    const fixture = await createFixture();
    const connectorLabel = 'com.metapi.connector.test';
    const reloaderLabel = 'com.metapi.connector.test.reloader';
    const connectorPlistPath = join(fixture.launchAgentsDir, `${connectorLabel}.plist`);
    const reloaderPlistPath = join(fixture.launchAgentsDir, `${reloaderLabel}.plist`);
    await Promise.all([
      writeFile(connectorPlistPath, '<plist/>\n'),
      writeFile(reloaderPlistPath, '<plist/>\n'),
      writeFile(join(fixture.dataDir, 'durable-event.json'), '{}\n'),
    ]);
    const execute = vi.fn(async () => undefined);

    await uninstallLocalConnectorServices({
      connectorLabel,
      reloaderLabel,
      launchAgentsDir: fixture.launchAgentsDir,
      home: fixture.home,
      uid: 501,
      execute,
      platform: 'darwin',
    });

    await expect(readFile(connectorPlistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(reloaderPlistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.configPath, 'utf8')).resolves.toContain('device-service');
    await expect(readFile(join(fixture.dataDir, 'durable-event.json'), 'utf8')).resolves.toBe('{}\n');
    expect(execute).toHaveBeenCalledWith('/bin/launchctl', [
      'bootout',
      'gui/501/com.metapi.connector.test.reloader',
    ]);
  });
});
