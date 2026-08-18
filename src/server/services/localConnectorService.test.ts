import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./localConnectorService.js');
type HealthServiceModule = typeof import('./localConnectorHealthService.js');

describe('local connector service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let healthService: HealthServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-local-connector-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./localConnectorService.js');
    healthService = await import('./localConnectorHealthService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.localConnectorActions).run();
    await db.delete(schema.localConnectorHealthChecks).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorDevices).run();
    await db.delete(schema.events).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function pair() {
    const pairing = await service.createLocalConnectorPairing({
      deviceName: 'MacBook Pro',
      scopes: ['hooks.manage', 'hooks.emit', 'notify.manage', 'notify.emit'],
    });
    const claimed = await service.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
      version: '0.1.0',
      capabilities: ['codex-hooks', 'notify'],
    });
    return { pairing, claimed };
  }

  it('uses one-time pairing material and stores only connector token hashes', async () => {
    const { pairing, claimed } = await pair();
    expect(pairing.pairingToken).toMatch(/^lcp_/);
    expect(claimed.connectorToken).toMatch(/^lc_/);
    expect(claimed.device).toMatchObject({
      name: 'MacBook Pro',
      platform: 'macos',
      status: 'active',
      scopes: ['hooks.manage', 'hooks.emit', 'notify.manage', 'notify.emit'],
      capabilities: ['codex-hooks', 'notify'],
    });
    expect(claimed.device).not.toHaveProperty('tokenHash');

    const storedDevice = await db.select().from(schema.localConnectorDevices).get();
    const storedPairing = await db.select().from(schema.localConnectorPairings).get();
    expect(storedDevice?.tokenHash).not.toContain(claimed.connectorToken);
    expect(storedPairing?.tokenHash).not.toContain(pairing.pairingToken);
    expect(storedPairing?.status).toBe('claimed');
    await expect(service.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
    })).rejects.toThrow(/已使用|已过期/);
  });

  it('refreshes the installed version and capabilities during heartbeat', async () => {
    const { claimed } = await pair();
    const identity = await service.authenticateLocalConnectorToken(claimed.connectorToken);
    expect(identity).not.toBeNull();

    const refreshed = await service.updateLocalConnectorRuntimeMetadata(identity!, {
      version: '1.0.1',
      capabilities: ['notify', 'local-dashboard-v1', 'notify'],
    });

    expect(refreshed.device).toMatchObject({
      version: '1.0.1',
      capabilities: ['notify', 'local-dashboard-v1'],
    });
    await expect(service.updateLocalConnectorRuntimeMetadata(refreshed, {})).resolves.toBe(refreshed);
    const stored = await db.select().from(schema.localConnectorDevices).get();
    expect(stored?.version).toBe('1.0.1');
    expect(stored?.capabilities).toBe(JSON.stringify(['notify', 'local-dashboard-v1']));
  });

  it('claims, completes, and idempotently repeats a hook installation action', async () => {
    const { claimed } = await pair();
    const action = await service.createLocalConnectorAction({
      deviceId: claimed.device.id,
      kind: 'hook',
      operation: 'install',
      eventNames: ['turn.completed', 'approval.required'],
    });
    expect(action.manifest).toMatchObject({
      protocol: 'metapi.local-connector.action.v1',
      kind: 'hook',
      operation: 'install',
      requiresBackup: true,
    });

    const identity = await service.authenticateLocalConnectorToken(claimed.connectorToken);
    expect(identity).not.toBeNull();
    const claimedAction = await service.claimNextLocalConnectorAction(identity!);
    expect(claimedAction?.id).toBe(action.id);

    const completed = await service.completeLocalConnectorAction({
      identity: identity!,
      actionId: action.id,
      status: 'succeeded',
      backupRef: 'backup:macos:2026-08-04T01:00:00Z',
      result: { installed: true, files: 3 },
    });
    expect(completed.idempotent).toBe(false);
    expect(completed.action).toMatchObject({
      status: 'succeeded',
      backupRef: 'backup:macos:2026-08-04T01:00:00Z',
      result: { installed: true, files: 3 },
    });

    const repeated = await service.completeLocalConnectorAction({
      identity: identity!,
      actionId: action.id,
      status: 'succeeded',
      result: { installed: true, files: 3 },
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.action.status).toBe('succeeded');
  });

  it('rejects actions outside the device scope and revocation immediately invalidates tokens', async () => {
    const pairing = await service.createLocalConnectorPairing({
      deviceName: 'Notify-only',
      scopes: ['notify.emit'],
    });
    const claimed = await service.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'linux',
    });
    await expect(service.createLocalConnectorAction({
      deviceId: claimed.device.id,
      kind: 'hook',
      operation: 'install',
    })).rejects.toThrow(/hooks.manage/);

    const identity = await service.authenticateLocalConnectorToken(claimed.connectorToken);
    expect(identity).not.toBeNull();
    await expect(service.recordLocalConnectorEvent({
      identity: identity!,
      kind: 'notify',
      title: 'turn finished',
      message: 'done',
      idempotencyKey: 'turn-1',
    })).resolves.toMatchObject({ notification: { attempted: 0 } });

    await expect(service.revokeLocalConnectorDevice(claimed.device.id)).resolves.toBe(true);
    await expect(service.authenticateLocalConnectorToken(claimed.connectorToken)).resolves.toBeNull();
  });

  it('does not allow a device to create a second unfinished action of the same kind', async () => {
    const { claimed } = await pair();
    await service.createLocalConnectorAction({
      deviceId: claimed.device.id,
      kind: 'notify',
      operation: 'install',
    });
    await expect(service.createLocalConnectorAction({
      deviceId: claimed.device.id,
      kind: 'notify',
      operation: 'backup',
    })).rejects.toThrow(/未完成/);
  });

  it('queues an automatic repair when the Codex notify wrapper becomes unavailable', async () => {
    const { claimed } = await pair();
    const identity = await service.authenticateLocalConnectorToken(claimed.connectorToken);
    expect(identity).not.toBeNull();

    const reported = await service.updateLocalConnectorRuntimeMetadata(identity!, {
      health: [{
        checkId: 'codex_notify',
        status: 'unavailable',
        reason: 'managed_wrapper_missing',
        observedAt: '2026-08-14T08:00:00.000Z',
      }],
    });
    const health = await db.select().from(schema.localConnectorHealthChecks)
      .where(eq(schema.localConnectorHealthChecks.checkId, 'codex_notify')).get();
    expect(health).toMatchObject({
      status: 'unavailable',
      reason: 'managed_wrapper_missing',
    });
    expect(health?.autoRepairActionId).toBeTruthy();
    await expect(db.select().from(schema.localConnectorActions).get()).resolves.toMatchObject({
      id: health?.autoRepairActionId,
      kind: 'notify',
      operation: 'install',
      status: 'pending',
    });

    await service.updateLocalConnectorRuntimeMetadata(reported, {
      health: [{
        checkId: 'codex_notify',
        status: 'healthy',
        reason: null,
        observedAt: '2026-08-14T08:00:05.000Z',
      }],
    });
    await expect(db.select().from(schema.localConnectorHealthChecks)
      .where(eq(schema.localConnectorHealthChecks.checkId, 'codex_notify')).get())
      .resolves.toMatchObject({ status: 'healthy' });
  });

  it('marks a failed automatic repair as alerted', async () => {
    const { claimed } = await pair();
    const identity = await service.authenticateLocalConnectorToken(claimed.connectorToken);
    await service.updateLocalConnectorRuntimeMetadata(identity!, {
      health: [{
        checkId: 'codex_notify',
        status: 'unavailable',
        reason: 'managed_wrapper_missing',
        observedAt: '2026-08-14T08:10:00.000Z',
      }],
    });
    const action = await service.claimNextLocalConnectorAction(identity!);
    expect(action).not.toBeNull();
    await service.completeLocalConnectorAction({
      identity: identity!,
      actionId: action!.id,
      status: 'failed',
      errorMessage: 'config is locked',
    });

    await healthService.runLocalConnectorHealthMonitorPass({
      now: new Date('2026-08-14T08:10:20.000Z'),
      notifyRepairGraceMs: 10_000,
      requestRepair: service.ensureLocalConnectorNotifyRepairAction,
    });
    const health = await db.select().from(schema.localConnectorHealthChecks)
      .where(eq(schema.localConnectorHealthChecks.checkId, 'codex_notify')).get();
    expect(health?.alertedAt).toBeTruthy();
  });

  it('detects a missing Connector heartbeat and records its recovery', async () => {
    const { claimed } = await pair();
    const identity = await service.authenticateLocalConnectorToken(claimed.connectorToken);
    await db.update(schema.localConnectorDevices).set({
      lastSeenAt: '2026-08-14T06:55:00.000Z',
    }).where(eq(schema.localConnectorDevices.id, claimed.device.id)).run();

    await healthService.runLocalConnectorHealthMonitorPass({
      now: new Date('2026-08-14T07:00:00.000Z'),
      offlineAfterMs: 30_000,
      requestRepair: service.ensureLocalConnectorNotifyRepairAction,
    });
    await expect(db.select().from(schema.localConnectorHealthChecks)
      .where(eq(schema.localConnectorHealthChecks.checkId, 'connector_runtime')).get())
      .resolves.toMatchObject({ status: 'unavailable' });

    await service.updateLocalConnectorRuntimeMetadata(identity!, { version: '0.1.0' });
    const recovered = await db.select().from(schema.localConnectorHealthChecks)
      .where(eq(schema.localConnectorHealthChecks.checkId, 'connector_runtime')).get();
    expect(recovered).toMatchObject({ status: 'healthy' });
    expect(recovered?.recoveryNotifiedAt).toBeTruthy();
  });
});
