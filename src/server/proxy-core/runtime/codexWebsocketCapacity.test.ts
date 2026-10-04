import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { canBindLocalTestListener } from '../../test-fixtures/localListenerCapability.js';

type DbModule = typeof import('../../db/index.js');
type Runtime = ReturnType<typeof import('./codexWebsocketRuntime.js')['createCodexWebsocketRuntime']>;
const localDescribe = canBindLocalTestListener() ? describe : describe.skip;
localDescribe('native websocket site capacity', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let server: WebSocketServer;
  let url: string;
  let runtime: Runtime;
  let requests: WebSocket[];
  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'r-api-ws-capacity-'));
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket) => { socket.on('message', () => requests.push(socket)); });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/responses`;
  });
  beforeEach(async () => {
    await db.delete(schema.siteConcurrencyLeases).run();
    await db.delete(schema.sites).run();
    requests = [];
    runtime = (await import('./codexWebsocketRuntime.js')).createCodexWebsocketRuntime();
  });
  afterAll(async () => { delete process.env.DATA_DIR; await new Promise<void>((resolve) => server.close(() => resolve())); });
  const site = () => db.insert(schema.sites).values({ name: 'site', url: 'https://example.com', platform: 'codex', maxConcurrency: 1 }).returning().get();
  const active = () => db.select().from(schema.siteConcurrencyLeases).all();
  const complete = (socket: WebSocket) => socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp-test', output: [] } }));

  it('counts active generations and releases terminal responses while keeping an idle connection', async () => {
    const row = await site();
    try {
      const first = runtime.sendRequest({ sessionId: 'one', requestUrl: url, headers: {}, site: row, body: {} });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(await active()).toHaveLength(1);
      await expect(runtime.sendRequest({ sessionId: 'two', requestUrl: url, headers: {}, site: row, body: {} })).rejects.toMatchObject({ code: 'site_capacity_unavailable' });
      expect(requests).toHaveLength(1);
      complete(requests[0]);
      await first;
      expect(await active()).toHaveLength(0);
      const next = runtime.sendRequest({ sessionId: 'one', requestUrl: url, headers: {}, site: row, body: {} });
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      complete(requests[1]);
      expect((await next).reusedSession).toBe(true);
      expect(await active()).toHaveLength(0);
    } finally { await runtime.closeAllSessions(); }
  });

  it('closes an unfinished generation before waiting and prevents queued requests reopening it', async () => {
    const row = await site();
    const first = runtime.sendRequest({ sessionId: 'one', requestUrl: url, headers: {}, site: row, body: {} });
    const firstFailure = expect(first).rejects.toThrow('disconnected');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const queued = runtime.sendRequest({ sessionId: 'one', requestUrl: url, headers: {}, site: row, body: {} });
    const queuedFailure = expect(queued).rejects.toThrow('disconnected');
    await runtime.closeSession('one');
    await Promise.all([firstFailure, queuedFailure]);
    expect(requests).toHaveLength(1);
    expect(await active()).toHaveLength(0);
  });

  it('cancels a queued turn immediately without aborting another active generation', async () => {
    const row = await site();
    try {
      const first = runtime.sendRequest({ sessionId: 'one', requestUrl: url, headers: {}, site: row, body: {} });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const controller = new AbortController();
      const queued = runtime.sendRequest({ sessionId: 'one', requestUrl: url, headers: {}, site: row, body: {}, signal: controller.signal });
      controller.abort(new DOMException('cancelled', 'AbortError'));
      await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
      expect(await active()).toHaveLength(1);
      complete(requests[0]);
      await first;
      await vi.waitFor(async () => expect(await active()).toHaveLength(0));
      expect(requests).toHaveLength(1);
    } finally { await runtime.closeAllSessions(); }
  });

  it('terminates a generation on fenced lease loss without replaying it', async () => {
    const service = await import('../../services/siteConcurrencyService.js');
    const acquire = vi.spyOn(service, 'acquireSiteConcurrencyLease');
    try {
      const row = await site();
      const first = runtime.sendRequest({ sessionId: 'one', requestUrl: url, headers: {}, site: row, body: {} });
      const failure = expect(first).rejects.toMatchObject({ code: 'site_capacity_unavailable' });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const lease = (await acquire.mock.results[0].value)!;
      await db.delete(schema.siteConcurrencyLeases).run();
      await expect(lease.renew()).rejects.toThrow('lost');
      await failure;
      expect(requests).toHaveLength(1);
      expect(await active()).toHaveLength(0);
    } finally { acquire.mockRestore(); await runtime.closeAllSessions(); }
  });
});
