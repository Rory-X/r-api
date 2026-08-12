import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireConnectorRuntimeState,
  inspectConnectorRuntimeState,
} from './runtimeState.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local connector runtime state', () => {
  it('uses the lock as truth and mirrors its PID for legacy tooling', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-state-'));
    roots.push(dataDir);
    await writeFile(join(dataDir, 'connector.pid'), '999999\n');

    const release = await acquireConnectorRuntimeState(dataDir);
    const state = await inspectConnectorRuntimeState(dataDir);

    expect(state).toMatchObject({
      lockStatus: 'active',
      running: true,
      pid: process.pid,
      pidFilePid: process.pid,
      pidFileMatchesLock: true,
    });
    expect(await readFile(join(dataDir, 'connector.pid'), 'utf8')).toBe(`${process.pid}\n`);

    await release();
    await expect(inspectConnectorRuntimeState(dataDir)).resolves.toMatchObject({
      lockStatus: 'missing',
      running: false,
      pid: null,
      pidFilePid: null,
    });
  });

  it('reports stale and invalid locks without trusting the PID file', async () => {
    const staleDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-stale-'));
    const invalidDir = await mkdtemp(join(tmpdir(), 'metapi-runtime-invalid-'));
    roots.push(staleDir, invalidDir);
    await writeFile(join(staleDir, 'connector.lock'), JSON.stringify({
      pid: 999999,
      startedAt: '2026-08-12T00:00:00.000Z',
    }));
    await writeFile(join(staleDir, 'connector.pid'), '123\n');
    await writeFile(join(invalidDir, 'connector.lock'), '{}\n');

    await expect(inspectConnectorRuntimeState(staleDir)).resolves.toMatchObject({
      lockStatus: 'stale',
      running: false,
      pid: 999999,
      pidFilePid: 123,
      pidFileMatchesLock: false,
    });
    await expect(inspectConnectorRuntimeState(invalidDir)).resolves.toMatchObject({
      lockStatus: 'invalid',
      running: false,
      pid: null,
    });
  });
});
