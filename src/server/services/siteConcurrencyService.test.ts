import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./siteConcurrencyService.js');

describe('deployment-wide site concurrency leases', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir: string;
  const options = { heartbeatIntervalMs: 0 };
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'r-api-site-concurrency-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    ({ db, schema } = await import('../db/index.js'));
    service = await import('./siteConcurrencyService.js');
  });
  beforeEach(async () => {
    await db.delete(schema.siteConcurrencyLeases).run();
    await db.delete(schema.sites).run();
  });
  afterAll(() => { delete process.env.DATA_DIR; });
  const site = (maxConcurrency: number | null, concurrencyWaitTimeoutMs = 0) => db.insert(schema.sites)
    .values({ name: 'capacity', url: 'https://example.com', platform: 'openai', maxConcurrency, concurrencyWaitTimeoutMs }).returning().get();

  it('leaves an unlimited site without leases and enforces a finite limit across callers', async () => {
    const unlimited = await site(null);
    expect(await service.acquireSiteConcurrencyLease(unlimited.id)).toBeNull();
    await db.update(schema.sites).set({ maxConcurrency: 2 }).where(eq(schema.sites.id, unlimited.id)).run();
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => service.acquireSiteConcurrencyLease(unlimited.id, options)));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(2);
    for (const outcome of outcomes) if (outcome.status === 'fulfilled') await outcome.value?.release();
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(0);
  });

  it('isolates sites and releases once even when called concurrently', async () => {
    const one = await site(1);
    const two = await db.insert(schema.sites).values({ name: 'second', url: 'https://second.example.com', platform: 'openai', maxConcurrency: 1 }).returning().get();
    const first = (await service.acquireSiteConcurrencyLease(one.id, options))!;
    const second = (await service.acquireSiteConcurrencyLease(two.id, options))!;
    await Promise.all([first.release(), first.release()]);
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(1);
    await second.release();
  });

  it('reclaims expired slots and fences stale owners from renewing or releasing a successor', async () => {
    const row = await site(1);
    const first = (await service.acquireSiteConcurrencyLease(row.id, options))!;
    await db.update(schema.siteConcurrencyLeases).set({ expiresAt: new Date(Date.now() - 1_000).toISOString() }).where(eq(schema.siteConcurrencyLeases.leaseToken, first.leaseToken)).run();
    const successor = (await service.acquireSiteConcurrencyLease(row.id, options))!;
    expect(successor.leaseToken).not.toBe(first.leaseToken);
    await expect(first.renew()).rejects.toThrow('lost or expired');
    expect(first.signal.aborted).toBe(true);
    await first.release();
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(1);
    await successor.release();
  });

  it('renewal extends the lease while an expired token cannot resurrect itself', async () => {
    const row = await site(1);
    const lease = (await service.acquireSiteConcurrencyLease(row.id, { ...options, ttlMs: 1_000 }))!;
    const original = lease.expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await lease.renew();
    expect(lease.expiresAt > original).toBe(true);
    await db.update(schema.siteConcurrencyLeases).set({ expiresAt: new Date(Date.now() - 1).toISOString() }).where(eq(schema.siteConcurrencyLeases.leaseToken, lease.leaseToken)).run();
    await expect(lease.renew()).rejects.toThrow('lost or expired');
    await lease.release();
  });

  it('waits for capacity, times out locally, and cancels a queued waiter without claiming a slot', async () => {
    const row = await site(1, 500);
    const first = (await service.acquireSiteConcurrencyLease(row.id, options))!;
    const waiting = service.acquireSiteConcurrencyLease(row.id, options);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await first.release();
    const acquired = (await waiting)!;
    await expect(service.acquireSiteConcurrencyLease(row.id, { ...options, waitTimeoutMs: 30 })).rejects.toMatchObject({ status: 503, code: 'site_capacity_unavailable' });
    const controller = new AbortController();
    const cancelled = service.acquireSiteConcurrencyLease(row.id, { ...options, signal: controller.signal });
    controller.abort(new Error('client gone'));
    await expect(cancelled).rejects.toThrow('client gone');
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(1);
    await acquired.release();
  });

  it('honors a reduced limit without revoking current requests or admitting an extra slot', async () => {
    const row = await site(3);
    const leases = await Promise.all(Array.from({ length: 3 }, () => service.acquireSiteConcurrencyLease(row.id, options)));
    await db.update(schema.sites).set({ maxConcurrency: 1 }).where(eq(schema.sites.id, row.id)).run();
    await leases[0]!.release();
    await expect(service.acquireSiteConcurrencyLease(row.id, options)).rejects.toMatchObject({ status: 503 });
    await leases[1]!.release();
    await expect(service.acquireSiteConcurrencyLease(row.id, options)).rejects.toMatchObject({ status: 503 });
    await leases[2]!.release();
    const next = await service.acquireSiteConcurrencyLease(row.id, options);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('uses database fencing between two independent Node processes sharing one SQLite file', async () => {
    const row = await site(1);
    const children: ChildProcessWithoutNullStreams[] = [];
    const worker = () => new Promise<{ child: ChildProcessWithoutNullStreams; acquired: boolean }>((resolveResult, reject) => {
      const moduleUrl = pathToFileURL(resolve('src/server/services/siteConcurrencyService.ts')).href;
      const script = `const s = await import(${JSON.stringify(moduleUrl)}); let lease; try { lease = await s.acquireSiteConcurrencyLease(${row.id}, { heartbeatIntervalMs: 0 }); process.stdout.write(JSON.stringify({acquired:true})+'\\n'); process.stdin.once('data', async () => { await lease.release(); process.exit(0); }); process.stdin.resume(); } catch (error) { process.stdout.write(JSON.stringify({acquired:false,code:error.code})+'\\n'); process.exit(0); }`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, DATA_DIR: dataDir, DB_TYPE: 'sqlite' } });
      children.push(child);
      let buffer = '';
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += String(data); });
      child.on('error', reject);
      child.once('exit', (code) => { if (code) reject(new Error(stderr)); });
      child.stdout.on('data', (data) => {
        buffer += String(data);
        const boundary = buffer.indexOf('\n');
        if (boundary < 0) return;
        const result = JSON.parse(buffer.slice(0, boundary));
        resolveResult({ child, acquired: result.acquired });
      });
    });
    try {
      const results = await Promise.all([worker(), worker()]);
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      expect(await db.select().from(schema.siteConcurrencyLeases).where(eq(schema.siteConcurrencyLeases.siteId, row.id)).all()).toHaveLength(1);
      results.find((result) => result.acquired)!.child.stdin.write('release');
      await vi.waitFor(async () => expect(await db.select().from(schema.siteConcurrencyLeases).where(and(eq(schema.siteConcurrencyLeases.siteId, row.id))).all()).toHaveLength(0));
    } finally { for (const child of children) child.kill(); }
  });
});
