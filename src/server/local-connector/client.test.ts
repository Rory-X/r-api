import { describe, expect, it, vi } from 'vitest';
import { LocalConnectorClient } from './client.js';

describe('local connector client', () => {
  it('sends heartbeat as an authenticated POST request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      device: { id: 'device-1' },
      serverTime: '2026-08-05T00:00:00.000Z',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new LocalConnectorClient(
      'http://127.0.0.1:4400',
      'lc_test_token',
      fetchMock as typeof fetch,
    );

    await expect(client.heartbeat({
      version: '1.0.1',
      capabilities: ['local-dashboard-v1'],
      health: [{
        checkId: 'codex_notify',
        status: 'healthy',
        reason: null,
        observedAt: '2026-08-14T08:00:00.000Z',
      }],
    })).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4400/api/local-connector/public/heartbeat');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer lc_test_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.1',
        capabilities: ['local-dashboard-v1'],
        health: [{
          checkId: 'codex_notify',
          status: 'healthy',
          reason: null,
          observedAt: '2026-08-14T08:00:00.000Z',
        }],
      }),
    });
  });

  it('uploads only the Desktop thread snapshot wire fields', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      observed: 1,
      released: 0,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new LocalConnectorClient(
      'http://127.0.0.1:4400',
      'lc_test_token',
      fetchMock as typeof fetch,
    );

    await expect(client.syncThreadSnapshots('codex_desktop', [{
      threadId: 'thread-1',
      status: 'active',
      activeTurnId: 'turn-1',
      updatedAt: '2026-08-11T01:00:00.000Z',
    }])).resolves.toBe(true);

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4400/api/local-connector/public/threads/snapshot');
    expect(options).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        source: 'codex_desktop',
        threads: [{
          threadId: 'thread-1',
          status: 'active',
          activeTurnId: 'turn-1',
          updatedAt: '2026-08-11T01:00:00.000Z',
        }],
      }),
    });
  });

  it('uploads controllable App Server state without dashboard-only metadata', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      observed: 1,
      released: 0,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new LocalConnectorClient(
      'http://127.0.0.1:4400',
      'lc_test_token',
      fetchMock as typeof fetch,
    );

    await expect(client.syncThreadSnapshots('connector_app_server', [{
      threadId: 'thread-control',
      status: 'active',
      activeFlags: ['waitingOnApproval'],
      updatedAt: '2026-08-11T02:00:00.000Z',
      title: 'must stay local',
      cwd: '/private/workspace',
    } as Parameters<typeof client.syncThreadSnapshots>[1][number]])).resolves.toBe(true);

    const [, options] = fetchMock.mock.calls[0];
    expect(options?.body).toBe(JSON.stringify({
      source: 'connector_app_server',
      threads: [{
        threadId: 'thread-control',
        title: 'must stay local',
        status: 'active',
        activeFlags: ['waitingOnApproval'],
        updatedAt: '2026-08-11T02:00:00.000Z',
      }],
    }));
  });

  it('keeps running against a server that does not support Desktop snapshots yet', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      message: 'not found',
    }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new LocalConnectorClient(
      'http://127.0.0.1:4400',
      'lc_test_token',
      fetchMock as typeof fetch,
    );

    await expect(client.syncThreadSnapshots('codex_desktop', [])).resolves.toBe(false);
  });
});
