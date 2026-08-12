import { describe, expect, it, vi } from 'vitest';
import { reloadCodexRuntime, watchCodexRuntimeConfig } from './codexRuntimeReload.js';

describe('Codex runtime reload', () => {
  it('restarts the managed daemon before kickstarting the Connector', async () => {
    const calls: Array<{ executable: string; argv: readonly string[] }> = [];
    const socketExists = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const healthCheck = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await reloadCodexRuntime({
      codexExecutable: '/opt/codex',
      connectorLaunchdLabel: 'com.metapi.connector.test',
      appServerSocketPath: '/tmp/codex.sock',
      connectorHealthUrl: 'http://127.0.0.1:4765/healthz',
      debounceMs: 0,
      socketTimeoutMs: 1_000,
      connectorHealthTimeoutMs: 1_000,
      uid: 501,
      execute: async (executable, argv) => {
        calls.push({ executable, argv });
      },
      socketExists,
      healthCheck,
      wait: async () => undefined,
    });
    expect(calls).toEqual([
      { executable: '/opt/codex', argv: ['app-server', 'daemon', 'restart'] },
      { executable: '/bin/launchctl', argv: ['kickstart', '-k', 'gui/501/com.metapi.connector.test'] },
    ]);
    expect(result).toEqual({
      appServerRestarted: true,
      connectorRestarted: true,
      connectorHealthy: true,
    });
  });

  it('reclaims an unmanaged Codex App Server before starting the managed daemon', async () => {
    const calls: Array<{ executable: string; argv: readonly string[] }> = [];
    const execute = vi.fn(async (executable: string, argv: readonly string[]) => {
      calls.push({ executable, argv });
      if (argv.join(' ') === 'app-server daemon restart') {
        throw new Error('/opt/codex app-server daemon restart failed (1): Error: app server is running but is not managed by codex app-server daemon');
      }
    });
    const findUnmanagedAppServerPid = vi.fn(async () => 42);
    const terminateUnmanagedAppServer = vi.fn(async () => undefined);
    const result = await reloadCodexRuntime({
      codexExecutable: '/opt/codex',
      connectorLaunchdLabel: 'com.metapi.connector.test',
      appServerSocketPath: '/tmp/codex.sock',
      debounceMs: 0,
      uid: 501,
      execute,
      findUnmanagedAppServerPid,
      terminateUnmanagedAppServer,
      socketExists: async () => true,
      wait: async () => undefined,
    });
    expect(findUnmanagedAppServerPid).toHaveBeenCalledWith('/tmp/codex.sock');
    expect(terminateUnmanagedAppServer).toHaveBeenCalledWith(42);
    expect(calls).toEqual([
      { executable: '/opt/codex', argv: ['app-server', 'daemon', 'restart'] },
      { executable: '/opt/codex', argv: ['app-server', 'daemon', 'start'] },
      { executable: '/bin/launchctl', argv: ['kickstart', '-k', 'gui/501/com.metapi.connector.test'] },
    ]);
    expect(result).toEqual({
      appServerRestarted: true,
      connectorRestarted: true,
      connectorHealthy: null,
      appServerOwnership: 'reclaimed',
    });
  });

  it('does not kill an unknown socket owner when unmanaged takeover cannot identify Codex', async () => {
    const execute = vi.fn(async () => {
      throw new Error('app server is running but is not managed by codex app-server daemon');
    });
    const terminateUnmanagedAppServer = vi.fn(async () => undefined);
    await expect(reloadCodexRuntime({
      codexExecutable: '/opt/codex',
      connectorLaunchdLabel: 'com.metapi.connector.test',
      appServerSocketPath: '/tmp/codex.sock',
      debounceMs: 0,
      uid: 501,
      execute,
      findUnmanagedAppServerPid: async () => null,
      terminateUnmanagedAppServer,
      wait: async () => undefined,
    })).rejects.toThrow('未找到可安全接管');
    expect(terminateUnmanagedAppServer).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not restart the Connector when the daemon socket fails to recover', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    await expect(reloadCodexRuntime({
      codexExecutable: '/opt/codex',
      connectorLaunchdLabel: 'com.metapi.connector.test',
      appServerSocketPath: '/tmp/missing.sock',
      debounceMs: 0,
      socketTimeoutMs: 0,
      uid: 501,
      execute,
      socketExists: async () => false,
      wait: async () => undefined,
    })).rejects.toThrow('socket 未在超时前恢复');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('supports a discovery-based Connector health check without a fixed URL', async () => {
    const connectorHealthCheck = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await reloadCodexRuntime({
      codexExecutable: '/opt/codex',
      connectorLaunchdLabel: 'com.metapi.connector.test',
      appServerSocketPath: '/tmp/codex.sock',
      connectorHealthCheck,
      debounceMs: 0,
      socketTimeoutMs: 1_000,
      connectorHealthTimeoutMs: 1_000,
      uid: 501,
      execute: async () => undefined,
      socketExists: async () => true,
      wait: async () => undefined,
    });
    expect(connectorHealthCheck).toHaveBeenCalledTimes(2);
    expect(result.connectorHealthy).toBe(true);
  });

  it('rejects unsafe launchd labels', async () => {
    await expect(reloadCodexRuntime({
      codexExecutable: '/opt/codex',
      connectorLaunchdLabel: 'bad/label',
      appServerSocketPath: '/tmp/codex.sock',
      debounceMs: 0,
      uid: 501,
      execute: async () => undefined,
    })).rejects.toThrow('launchd label');
  });

  it('establishes a baseline and reloads only after a config fingerprint changes', async () => {
    const controller = new AbortController();
    const fingerprints = ['a', 'a', 'b', 'b'];
    const reload = vi.fn().mockResolvedValue({
      appServerRestarted: true,
      connectorRestarted: true,
      connectorHealthy: true,
    });
    await watchCodexRuntimeConfig({
      configPaths: ['/tmp/auth.json', '/tmp/config.toml'],
      reloadOptions: {
        codexExecutable: '/opt/codex',
        connectorLaunchdLabel: 'com.metapi.connector.test',
        appServerSocketPath: '/tmp/codex.sock',
      },
      signal: controller.signal,
      fingerprint: async () => fingerprints.shift() || 'b',
      reload,
      wait: async () => {
        if (fingerprints.length === 0) controller.abort();
      },
      onReload: () => controller.abort(),
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('absorbs Codex config normalization into the completed reload baseline', async () => {
    const controller = new AbortController();
    const fingerprints = ['before', 'changed-by-user', 'normalized-by-codex', 'normalized-by-codex'];
    const reload = vi.fn().mockResolvedValue({
      appServerRestarted: true,
      connectorRestarted: true,
      connectorHealthy: true,
    });
    let waits = 0;
    await watchCodexRuntimeConfig({
      configPaths: ['/tmp/auth.json', '/tmp/config.toml'],
      reloadOptions: {
        codexExecutable: '/opt/codex',
        connectorLaunchdLabel: 'com.metapi.connector.test',
        appServerSocketPath: '/tmp/codex.sock',
      },
      signal: controller.signal,
      fingerprint: async () => fingerprints.shift() || 'normalized-by-codex',
      reload,
      wait: async () => {
        waits += 1;
        if (waits >= 3) controller.abort();
      },
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
