import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { resetCodexSessionResponseStore } from './codexSessionResponseStore.js';
import { canBindLocalTestListener } from '../../test-fixtures/localListenerCapability.js';

const describeWithLocalListener = canBindLocalTestListener() ? describe : describe.skip;

describeWithLocalListener('codexWebsocketRuntime', () => {
  let upstreamServer: WebSocketServer;
  let upstreamWsUrl: string;
  let upstreamConnectionCount = 0;
  let upstreamRequests: Record<string, unknown>[] = [];
  let upstreamHeaders: import('node:http').IncomingHttpHeaders[] = [];
  let upstreamMessageHandler: (socket: import('ws').WebSocket, parsed: Record<string, unknown>, requestIndex: number) => void;

  beforeAll(async () => {
    upstreamServer = new WebSocketServer({ port: 0 });
    upstreamServer.on('connection', (socket, request) => {
      upstreamConnectionCount += 1;
      upstreamHeaders.push(request.headers);
      socket.on('message', (payload) => {
        const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
        upstreamRequests.push(parsed);
        upstreamMessageHandler(socket, parsed, upstreamRequests.length);
      });
    });
    await new Promise<void>((resolve) => upstreamServer.once('listening', () => resolve()));
    const address = upstreamServer.address() as AddressInfo;
    upstreamWsUrl = `ws://127.0.0.1:${address.port}/backend-api/codex/responses`;
  });

  beforeEach(() => {
    resetCodexSessionResponseStore();
    upstreamConnectionCount = 0;
    upstreamRequests = [];
    upstreamHeaders = [];
    upstreamMessageHandler = (socket, parsed, requestIndex) => {
      const responseId = `resp-${requestIndex}`;
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: responseId,
          object: 'response',
          model: parsed.model || 'gpt-5.4',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        },
      }));
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it.each([false, true])('applies site header priority %s to the actual upstream handshake', async (enabled) => {
    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();
    const sessionId = `header-priority-${enabled}`;
    try {
      await runtime.sendRequest({
        sessionId,
        requestUrl: upstreamWsUrl,
        headers: {
          Authorization: 'Bearer request',
          Cookie: 'request=1',
          'Content-Type': 'application/json',
          'User-Agent': 'request-agent',
          Version: 'request-version',
          'OpenAI-Beta': 'runtime-beta=1',
        },
        site: {
          customHeaders: JSON.stringify({
            authorization: 'Bearer site',
            cookie: 'site=1',
            'content-type': 'application/site+json',
            'user-agent': 'site-agent',
            version: 'site-version',
            'openai-beta': 'site-beta=1',
            'x-site-only': 'present',
          }),
          customHeadersOverrideRequestHeaders: enabled,
        },
        body: { model: 'gpt-5.4', input: [] },
      });
      expect(upstreamHeaders[0]).toMatchObject({
        authorization: enabled ? 'Bearer site' : 'Bearer request',
        cookie: enabled ? 'site=1' : 'request=1',
        'content-type': enabled ? 'application/site+json' : 'application/json',
        'user-agent': enabled ? 'site-agent' : 'request-agent',
        version: enabled ? 'site-version' : 'request-version',
        'x-site-only': 'present',
      });
      if (enabled) expect(upstreamHeaders[0]['openai-beta']).toBe('site-beta=1');
      else expect(upstreamHeaders[0]['openai-beta']).toContain('runtime-beta=1,responses_websockets=');
    } finally {
      await runtime.closeSession(sessionId);
    }
  });

  it('reuses the same upstream websocket connection across turns for one execution session', async () => {
    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();
    const lifecycleEvents: string[] = [];

    const first = await runtime.sendRequest({
      sessionId: 'exec-session-1',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
      onAttemptEvent: (event) => {
        lifecycleEvents.push(event.type);
      },
    });

    const second = await runtime.sendRequest({
      sessionId: 'exec-session-1',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        previous_response_id: 'resp-1',
        input: [],
      },
    });

    expect(first.events[0]).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp-1' },
    });
    expect(second.events[0]).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp-2' },
    });
    expect(upstreamConnectionCount).toBe(1);
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[0]).toMatchObject({
      type: 'response.create',
      model: 'gpt-5.4',
    });
    expect(upstreamRequests[1]).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp-1',
    });
    expect(lifecycleEvents).toEqual([
      'attempt_started',
      'request_sent',
      'response_started',
      'completed',
    ]);

    await runtime.closeSession('exec-session-1');
  });

  it('reconnects after site header settings change while preserving response continuation', async () => {
    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();
    const input = {
      sessionId: 'exec-session-header-edit', requestUrl: upstreamWsUrl,
      headers: { Authorization: 'Bearer request' },
      site: { customHeaders: '{"authorization":"Bearer site"}', customHeadersOverrideRequestHeaders: false },
      body: { model: 'gpt-5.4', input: [] },
    };
    try {
      await runtime.sendRequest(input);
      const reused = await runtime.sendRequest({
        ...input,
        site: { ...input.site, customHeaders: '{ "Authorization": "Bearer site" }' },
      });
      expect(reused.reusedSession).toBe(true);
      const changed = await runtime.sendRequest({
        ...input,
        site: { ...input.site, customHeadersOverrideRequestHeaders: true },
        body: { model: 'gpt-5.4', input: [{ type: 'function_call_output', call_id: 'header-edit-call', output: 'ok' }] },
      });
      expect(changed.reusedSession).toBe(false);
      expect(upstreamConnectionCount).toBe(2);
      expect(upstreamHeaders.map((headers) => headers.authorization)).toEqual(['Bearer request', 'Bearer site']);
      expect(upstreamRequests[2]).toMatchObject({ previous_response_id: 'resp-2' });
      await runtime.sendRequest({
        ...input,
        site: { customHeadersOverrideRequestHeaders: true, customHeaders: '{"Authorization":"Bearer rotated"}' },
      });
      expect(upstreamConnectionCount).toBe(3);
      expect(upstreamHeaders[2].authorization).toBe('Bearer rotated');
    } finally {
      await runtime.closeSession(input.sessionId);
    }
  });

  it('closes the upstream websocket when the execution session is closed explicitly', async () => {
    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    await runtime.sendRequest({
      sessionId: 'exec-session-close',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });
    await runtime.closeSession('exec-session-close');

    await runtime.sendRequest({
      sessionId: 'exec-session-close',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });

    expect(upstreamConnectionCount).toBe(2);
    await runtime.closeSession('exec-session-close');
  });

  it('preserves remembered continuation ids across websocket session closes and reconnects', async () => {
    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    await runtime.sendRequest({
      sessionId: 'exec-session-continue-after-close',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });

    await runtime.closeSession('exec-session-continue-after-close');

    const recovered = await runtime.sendRequest({
      sessionId: 'exec-session-continue-after-close',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [
          {
            id: 'tool_out_runtime_1',
            type: 'function_call_output',
            call_id: 'call_runtime_1',
            output: '{"ok":true}',
          },
        ],
      },
    });

    expect(recovered.events[0]).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp-2' },
    });
    expect(upstreamConnectionCount).toBe(2);
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[1]).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp-1',
      input: [
        {
          id: 'tool_out_runtime_1',
          type: 'function_call_output',
          call_id: 'call_runtime_1',
          output: '{"ok":true}',
        },
      ],
    });

    await runtime.closeSession('exec-session-continue-after-close');
  });

  it('returns response.incomplete as a terminal websocket event without rejecting the session turn', async () => {
    upstreamMessageHandler = (socket, parsed) => {
      socket.send(JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'resp-incomplete',
          model: parsed.model || 'gpt-5.4',
          status: 'incomplete',
          incomplete_details: {
            reason: 'max_output_tokens',
          },
        },
      }));
    };

    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();
    const lifecycleEvents: string[] = [];

    const result = await runtime.sendRequest({
      sessionId: 'exec-session-incomplete',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
      onAttemptEvent: (event) => {
        lifecycleEvents.push(event.type);
      },
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'response.incomplete',
      }),
    ]);
    expect(result.reusedSession).toBe(false);
    expect(lifecycleEvents).toEqual([
      'attempt_started',
      'request_sent',
      'response_started',
      'failed',
    ]);

    await runtime.closeSession('exec-session-incomplete');
  });

  it('keeps the upstream websocket session alive across response.failed terminal turns', async () => {
    upstreamMessageHandler = (socket, parsed, requestIndex) => {
      if (requestIndex === 1) {
        socket.send(JSON.stringify({
          type: 'response.failed',
          response: {
            id: 'resp-failed',
            model: parsed.model || 'gpt-5.4',
            status: 'failed',
            error: {
              message: 'tool execution failed',
              type: 'server_error',
            },
          },
        }));
        return;
      }

      socket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: `resp-${requestIndex}`,
          object: 'response',
          model: parsed.model || 'gpt-5.4',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        },
      }));
    };

    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    const first = await runtime.sendRequest({
      sessionId: 'exec-session-failed-turn',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });

    const second = await runtime.sendRequest({
      sessionId: 'exec-session-failed-turn',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        previous_response_id: 'resp-failed',
        input: [],
      },
    });

    expect(first.events).toEqual([
      expect.objectContaining({
        type: 'response.failed',
        response: expect.objectContaining({
          id: 'resp-failed',
          error: expect.objectContaining({
            message: 'tool execution failed',
          }),
        }),
      }),
    ]);
    expect(first.reusedSession).toBe(false);
    expect(second.events[0]).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp-2' },
    });
    expect(second.reusedSession).toBe(true);
    expect(upstreamConnectionCount).toBe(1);
    expect(upstreamRequests).toHaveLength(2);

    await runtime.closeSession('exec-session-failed-turn');
  });

  it('fails the current turn and opens a fresh websocket on the next turn when a reused session closes before yielding any events', async () => {
    upstreamMessageHandler = (socket, parsed, requestIndex) => {
      if (requestIndex === 1) {
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp-1',
            object: 'response',
            model: parsed.model || 'gpt-5.4',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
            },
          },
        }));
        return;
      }

      if (requestIndex === 2) {
        socket.close();
        return;
      }

      socket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp-3',
          object: 'response',
          model: parsed.model || 'gpt-5.4',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        },
      }));
    };

    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    await runtime.sendRequest({
      sessionId: 'exec-session-retry-stale',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });

    await expect(runtime.sendRequest({
      sessionId: 'exec-session-retry-stale',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        previous_response_id: 'resp-1',
        input: [],
      },
    })).rejects.toThrow('stream closed before response.completed');

    const recovered = await runtime.sendRequest({
      sessionId: 'exec-session-retry-stale',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        previous_response_id: 'resp-1',
        input: [],
      },
    });

    expect(recovered.events[0]).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp-3' },
    });
    expect(recovered.reusedSession).toBe(false);
    expect(upstreamConnectionCount).toBe(2);
    expect(upstreamRequests).toHaveLength(3);
    expect(upstreamRequests[1]).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp-1',
    });
    expect(upstreamRequests[2]).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp-1',
    });

    await runtime.closeSession('exec-session-retry-stale');
  });

  it('treats top-level error frames as terminal websocket failures', async () => {
    upstreamMessageHandler = (socket) => {
      socket.send(JSON.stringify({
        type: 'error',
        error: {
          message: 'account mismatch',
          type: 'invalid_request_error',
        },
      }));
    };

    const { createCodexWebsocketRuntime, CodexWebsocketRuntimeError } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    let error: unknown;
    try {
      await runtime.sendRequest({
        sessionId: 'exec-session-error',
        requestUrl: upstreamWsUrl,
        headers: {
          Authorization: 'Bearer oauth-access-token',
          'OpenAI-Beta': 'responses_websockets=2026-02-06',
        },
        body: {
          model: 'gpt-5.4',
          input: [],
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CodexWebsocketRuntimeError);
    expect(error).toMatchObject({
      message: 'account mismatch',
      status: 502,
    });
    const runtimeError = error as InstanceType<typeof CodexWebsocketRuntimeError>;
    expect(runtimeError.events).toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          message: 'account mismatch',
        }),
      }),
    ]);
  });
});
