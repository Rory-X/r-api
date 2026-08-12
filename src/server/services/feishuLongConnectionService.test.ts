import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Domain, type WSConnectionState } from '@larksuiteoapi/node-sdk';

const { callbackMock } = vi.hoisted(() => ({ callbackMock: vi.fn() }));

vi.mock('./feishuInteractionAdapterService.js', () => ({
  handleFeishuLongConnectionCallback: callbackMock,
}));

import {
  FeishuLongConnectionManager,
  type FeishuLongConnectionConfig,
} from './feishuLongConnectionService.js';

function config(overrides: Partial<FeishuLongConnectionConfig> = {}): FeishuLongConnectionConfig {
  return Object.freeze({
    adapterId: 'adapter-1',
    appId: 'cli_0123456789abcdef',
    appSecret: 'app-secret',
    verificationToken: 'verification-token',
    encryptKey: null,
    domain: Domain.Feishu,
    fingerprint: 'fingerprint-1',
    ...overrides,
  });
}

describe('Feishu long connection manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callbackMock.mockResolvedValue({ success: true });
  });

  it('keeps one live client for an unchanged adapter configuration', async () => {
    const clients: Array<{
      start: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      state: WSConnectionState;
    }> = [];
    const manager = new FeishuLongConnectionManager(() => {
      const client = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        state: 'connected' as WSConnectionState,
      };
      clients.push(client);
      return {
        start: client.start,
        close: client.close,
        status: () => ({ state: client.state, reconnectAttempts: 0 }),
      };
    });

    await manager.sync([config()]);
    await manager.sync([config()]);

    expect(clients).toHaveLength(1);
    expect(clients[0]?.start).toHaveBeenCalledTimes(1);
    expect(clients[0]?.close).not.toHaveBeenCalled();
  });

  it('does not block config sync while the SDK establishes its first connection', async () => {
    const manager = new FeishuLongConnectionManager(() => ({
      start: vi.fn(() => new Promise<void>(() => undefined)),
      close: vi.fn(),
      status: () => ({ state: 'connecting', reconnectAttempts: 0 }),
    }));

    await expect(manager.sync([config()])).resolves.toBeUndefined();
    expect(manager.snapshots()).toMatchObject([{ adapterId: 'adapter-1', state: 'connecting' }]);
    manager.stop();
  });

  it('replaces connections when credentials change or the client has failed', async () => {
    const clients: Array<{
      close: ReturnType<typeof vi.fn>;
      state: WSConnectionState;
    }> = [];
    const manager = new FeishuLongConnectionManager(() => {
      const client = { close: vi.fn(), state: 'connected' as WSConnectionState };
      clients.push(client);
      return {
        start: vi.fn().mockResolvedValue(undefined),
        close: client.close,
        status: () => ({ state: client.state, reconnectAttempts: 0 }),
      };
    });

    await manager.sync([config()]);
    await manager.sync([config({ fingerprint: 'fingerprint-2' })]);
    expect(clients).toHaveLength(2);
    expect(clients[0]?.close).toHaveBeenCalledTimes(1);

    clients[1]!.state = 'failed';
    await manager.sync([config({ fingerprint: 'fingerprint-2' })]);
    expect(clients).toHaveLength(3);
    expect(clients[1]?.close).toHaveBeenCalledTimes(1);
  });

  it('closes connections for removed adapters and on stop', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const manager = new FeishuLongConnectionManager(() => {
      const close = vi.fn();
      closes.push(close);
      return {
        start: vi.fn().mockResolvedValue(undefined),
        close,
        status: () => ({ state: 'connected', reconnectAttempts: 0 }),
      };
    });

    await manager.sync([
      config(),
      config({ adapterId: 'adapter-2', fingerprint: 'fingerprint-2' }),
    ]);
    await manager.sync([config()]);
    expect(closes[1]).toHaveBeenCalledTimes(1);

    manager.stop();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(manager.snapshots()).toEqual([]);
  });

  it.each(['im.message.receive_v1', 'card.action.trigger'])(
    'forwards %s through the shared Feishu callback service',
    async (eventType) => {
      let onEvent!: (
        eventType: string,
        event: Record<string, unknown>,
        eventId?: string,
      ) => Promise<unknown>;
      const manager = new FeishuLongConnectionManager((input) => {
        onEvent = input.onEvent;
        return {
          start: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
          status: () => ({ state: 'connected', reconnectAttempts: 0 }),
        };
      });
      await manager.sync([config()]);

      const event = { event_id: 'event-1', message: { message_id: 'message-1' } };
      await onEvent(eventType, event, 'event-1');

      expect(callbackMock).toHaveBeenCalledWith({
        adapterId: 'adapter-1',
        eventType,
        event,
        eventId: 'event-1',
      });
    },
  );

  it('logs only sanitized identifiers and the inbound handling outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    callbackMock.mockResolvedValueOnce({ success: true, ignored: true, reason: 'topic_not_bound' });
    let onEvent!: (
      eventType: string,
      event: Record<string, unknown>,
      eventId?: string,
    ) => Promise<unknown>;
    const manager = new FeishuLongConnectionManager((input) => {
      onEvent = input.onEvent;
      return {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        status: () => ({ state: 'connected', reconnectAttempts: 0 }),
      };
    });
    await manager.sync([config()]);

    await onEvent('im.message.receive_v1', {
      message: {
        message_id: 'om_message_1',
        root_id: 'om_root_1',
        thread_id: 'omt_thread_1',
        content: JSON.stringify({ text: 'private prompt must not be logged' }),
      },
    }, 'event-1');

    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('"outcome":"ignored"');
    expect(logged).toContain('"reason":"topic_not_bound"');
    expect(logged).toContain('"messageId":"om_message_1"');
    expect(logged).not.toContain('private prompt must not be logged');
    warn.mockRestore();
    manager.stop();
  });
});
