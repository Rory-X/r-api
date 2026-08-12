import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local connector runtime lifecycle', () => {
  it('keeps an idle connector process alive between polling passes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-lifecycle-'));
    roots.push(dataDir);
    const runtimeUrl = new URL(`file://${resolve('src/server/local-connector/runtime.ts')}`).href;
    const script = `
      import { LocalConnectorRuntime } from ${JSON.stringify(runtimeUrl)};
      const client = {
        emitEvent: async () => undefined,
        completeAction: async () => undefined,
        completeBridgeContinuation: async () => undefined,
        emitBridgeAppServerEvent: async () => undefined,
        claimNextAction: async () => null,
      };
      const runtime = new LocalConnectorRuntime({
        protocol: 'metapi.local-connector.config.v1',
        serverUrl: 'http://127.0.0.1:4000',
        deviceId: 'device-lifecycle',
        connectorToken: 'lc_lifecycle',
        backupKey: Buffer.alloc(32).toString('base64url'),
        pairedAt: '2026-08-05T00:00:00.000Z',
        pollIntervalMs: 50,
        dataDir: ${JSON.stringify(dataDir)},
      }, ${JSON.stringify(join(dataDir, 'config.json'))}, {
        executable: process.execPath,
        argv: ['/opt/metapi-connector.js'],
      }, client);
      const controller = new AbortController();
      process.once('SIGTERM', () => controller.abort());
      await runtime.run({ signal: controller.signal });
    `;
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false;
    child.once('exit', () => { exited = true; });

    const discoveryPath = join(dataDir, 'connector.dashboard.json');
    await waitForFile(discoveryPath);
    expect(exited).toBe(false);

    child.kill('SIGTERM');
    await once(child, 'exit');
    await expect(access(discoveryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);
});
