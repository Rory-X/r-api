import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ConnectorService = typeof import('./localConnectorService.js');
type ThreadService = typeof import('./localConnectorThreadService.js');
type ControlPlaneService = typeof import('./localConnectorControlPlaneService.js');

describe('Local Connector control plane service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let connector: ConnectorService;
  let threads: ThreadService;
  let controlPlane: ControlPlaneService;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-connector-control-plane-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    connector = await import('./localConnectorService.js');
    threads = await import('./localConnectorThreadService.js');
    controlPlane = await import('./localConnectorControlPlaneService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorThreads).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorDevices).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function pair(name: string) {
    const pairing = await connector.createLocalConnectorPairing({
      deviceName: name,
      scopes: ['app_server.observe', 'app_server.control'],
    });
    return await connector.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
    });
  }

  it('takes over only an observed device-owned thread and reuses its Bridge context', async () => {
    const owner = await pair('Owner Mac');
    const other = await pair('Other Mac');
    await threads.recordLocalConnectorThreadEvent({
      deviceId: owner.device.id,
      event: {
        kind: 'thread_status',
        threadId: 'thread-observed',
        status: 'idle',
        activeFlags: [],
      },
    });

    const first = await controlPlane.takeOverLocalConnectorThread({
      deviceId: owner.device.id,
      threadId: 'thread-observed',
    });
    expect(first).toMatchObject({
      created: true,
      task: {
        deviceId: owner.device.id,
        state: {
          threadId: 'thread-observed',
          threadStatus: 'idle',
        },
      },
    });
    expect(first.task.state.sessionKey).toBe(`connector:${owner.device.id}:codex:thread-observed`);

    const repeated = await controlPlane.takeOverLocalConnectorThread({
      deviceId: owner.device.id,
      threadId: 'thread-observed',
    });
    expect(repeated.created).toBe(false);
    expect(repeated.task.state.taskId).toBe(first.task.state.taskId);

    await expect(controlPlane.takeOverLocalConnectorThread({
      deviceId: other.device.id,
      threadId: 'thread-observed',
    })).rejects.toThrow(/不属于此 Connector/);
  });

  it('rejects takeover while Codex Desktop owns its App Server writer', async () => {
    const owner = await pair('Desktop Owner Mac');
    await threads.recordLocalConnectorThreadEvent({
      deviceId: owner.device.id,
      event: {
        kind: 'turn_started',
        threadId: 'desktop-owned-thread',
        turnId: 'desktop-turn-1',
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
      },
    });

    await expect(controlPlane.takeOverLocalConnectorThread({
      deviceId: owner.device.id,
      threadId: 'desktop-owned-thread',
    })).rejects.toThrow(/Desktop App Server 持有/);

    const tasks = await db.select().from(schema.bridgeContinuationTasks).all();
    expect(tasks).toHaveLength(0);
  });
});
