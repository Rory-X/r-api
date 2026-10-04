import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import { fetchWithObservedFirstByte, getObservedResponseMeta } from './firstByteTimeout.js';

type DbModule = typeof import('../db/index.js');
type Capacity = typeof import('./siteCapacity.js');

describe('site capacity transport lifecycle', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let capacity: Capacity;
  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'r-api-capacity-transport-'));
    await import('../db/migrate.js');
    ({ db, schema } = await import('../db/index.js'));
    capacity = await import('./siteCapacity.js');
  });
  beforeEach(async () => {
    await db.delete(schema.siteConcurrencyLeases).run();
    await db.delete(schema.sites).run();
  });
  afterAll(() => { delete process.env.DATA_DIR; });
  const createSite = (wait = 0, max: number | null = 1) => db.insert(schema.sites).values({ name: 'site', url: 'https://example.com', platform: 'openai', maxConcurrency: max, concurrencyWaitTimeoutMs: wait }).returning().get();
  const active = () => db.select().from(schema.siteConcurrencyLeases).all();
  const openResponse = () => new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }));

  it('holds capacity beyond headers through EOF and rejects competing dispatch without sending', async () => {
    const site = await createSite();
    const response = await capacity.withSiteCapacityResponse(site, async () => new Response('hello'));
    expect(await active()).toHaveLength(1);
    const dispatch = vi.fn();
    await expect(capacity.withSiteCapacityResponse(site, dispatch)).rejects.toMatchObject({ status: 503, code: 'site_capacity_unavailable' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await response.text()).toBe('hello');
    expect(await active()).toHaveLength(0);
    const next = await capacity.withSiteCapacityResponse(site, async () => new Response(null, { status: 204 }));
    expect(next.status).toBe(204);
    expect(await active()).toHaveLength(0);
  });

  it('releases for cancellation, dispatch failure and a body read error', async () => {
    const site = await createSite();
    const response = await capacity.withSiteCapacityResponse(site, async () => openResponse());
    await response.body!.cancel();
    expect(await active()).toHaveLength(0);
    await expect(capacity.withSiteCapacityResponse(site, async () => { throw new Error('dispatch failed'); })).rejects.toThrow('dispatch failed');
    expect(await active()).toHaveLength(0);
    const broken = await capacity.withSiteCapacityResponse(site, async () => new Response(new ReadableStream({ pull() { throw new Error('read failed'); } })));
    await expect(broken.text()).rejects.toThrow('read failed');
    expect(await active()).toHaveLength(0);
  });

  it('cancels a waiting request before dispatch and an active unread response on client disconnect', async () => {
    const site = await createSite(500);
    const abort = new AbortController();
    const response = await capacity.withSiteCapacityResponse(site, async () => openResponse(), abort.signal);
    const waiter = new AbortController();
    const dispatch = vi.fn();
    const pending = capacity.withSiteCapacityResponse(site, dispatch, waiter.signal);
    waiter.abort(new DOMException('cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispatch).not.toHaveBeenCalled();
    abort.abort(new DOMException('disconnected', 'AbortError'));
    await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => expect(await active()).toHaveLength(0));
  });

  it('excludes queue waiting from first-byte timeout and latency, including combined signals', async () => {
    const site = await createSite(1_000);
    const first = await capacity.withSiteCapacityResponse(site, async () => openResponse());
    const begin = Date.now();
    const pending = fetchWithObservedFirstByte(async (observedSignal) => {
      const signal = AbortSignal.any([observedSignal!, new AbortController().signal]);
      return capacity.withSiteCapacityResponse(site, async () => new Response('fast'), signal);
    }, { firstByteTimeoutMs: 60 });
    await new Promise((resolve) => setTimeout(resolve, 140));
    await first.body!.cancel();
    const result = await pending;
    expect(Date.now() - begin).toBeGreaterThan(100);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('fast');
    expect(getObservedResponseMeta(result)!.firstByteLatencyMs).toBeLessThan(60);
    expect(await active()).toHaveLength(0);
  });

  it('times out real upstream silence after admission and releases the slot', async () => {
    const site = await createSite(1_000);
    const first = await capacity.withSiteCapacityResponse(site, async () => openResponse());
    const pending = fetchWithObservedFirstByte((signal) => capacity.withSiteCapacityResponse(site, async () => openResponse(), signal), { firstByteTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.body!.cancel();
    const response = await pending;
    expect(response.status).toBe(408);
    await vi.waitFor(async () => expect(await active()).toHaveLength(0));
  });

  it('reports a queue deadline as local 503 rather than upstream timeout', async () => {
    const site = await createSite(100);
    const first = await capacity.withSiteCapacityResponse(site, async () => openResponse());
    await expect(fetchWithObservedFirstByte((signal) => capacity.withSiteCapacityResponse(site, vi.fn(), signal), { firstByteTimeoutMs: 30 })).rejects.toMatchObject({ code: 'site_capacity_unavailable' });
    await first.body!.cancel();
  });

  it('dynamically rechecks an unlimited cached record after its DB policy changes', async () => {
    const cached = await createSite(0, null);
    await db.update(schema.sites).set({ maxConcurrency: 1 }).where(eq(schema.sites.id, cached.id)).run();
    const response = await capacity.withSiteCapacityResponse(cached, async () => openResponse());
    await expect(capacity.withSiteCapacityOperation(cached, vi.fn())).rejects.toMatchObject({ status: 503 });
    await response.body!.cancel();
  });

  it('aborts on fenced lease loss and preserves the local error through whole-body reads', async () => {
    const service = await import('../services/siteConcurrencyService.js');
    const acquire = vi.spyOn(service, 'acquireSiteConcurrencyLease');
    const site = await createSite();
    const response = await capacity.withSiteCapacityResponse(site, async () => openResponse());
    const lease = (await acquire.mock.results[0].value)!;
    await db.delete(schema.siteConcurrencyLeases).run();
    await expect(lease.renew()).rejects.toThrow('lost');
    const { readRuntimeResponseText } = await import('./executors/types.js');
    await expect(readRuntimeResponseText(response)).rejects.toMatchObject({ code: 'site_capacity_unavailable' });
    await vi.waitFor(async () => expect(await active()).toHaveLength(0));
    acquire.mockRestore();
  });
});
