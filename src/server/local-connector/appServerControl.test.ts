import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerControlClient,
  normalizeAppServerControlNotification,
} from './appServerControl.js';

function fakeTransport(onRequest: (message: Record<string, any>, readable: PassThrough) => void) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  let buffer = '';
  writable.setEncoding('utf8');
  writable.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onRequest(JSON.parse(line), readable);
      newline = buffer.indexOf('\n');
    }
  });
  return {
    readable,
    writable,
    close: async () => {
      readable.end();
      writable.end();
    },
  };
}

describe('Codex App Server control client', () => {
  it('resumes a thread and starts the next turn with fixed continuation metadata', async () => {
    const messages: Record<string, any>[] = [];
    const transport = fakeTransport((message, readable) => {
      messages.push(message);
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`);
      } else if (message.method === 'thread/resume') {
        readable.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'thread-a' } } })}\n`);
      } else if (message.method === 'turn/start') {
        readable.write(`${JSON.stringify({ id: message.id, result: { turn: { id: 'turn-b' } } })}\n`);
      }
    });
    const client = new CodexAppServerControlClient({ transportFactory: async () => transport });
    const result = await client.continueThread({
      taskId: 'task-a',
      method: 'turn/start',
      threadId: 'thread-a',
      prompt: '继续',
      routeAction: 'rotate_credential',
      continuationNumber: 2,
    });
    expect(result).toEqual({ turnId: 'turn-b' });
    expect(messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'turn/start',
    ]);
    expect(messages[0]).toMatchObject({
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codex-desktop',
          title: 'Codex Desktop',
          version: '1.0.4',
        },
      },
    });
    expect(JSON.stringify(messages[0])).not.toContain('metapi-local-connector');
    expect(messages.at(-1)).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-a',
        input: [{ type: 'text', text: '继续' }],
        clientUserMessageId: 'metapi:task-a:2',
        responsesapiClientMetadata: {
          metapi_bridge_task_id: 'task-a',
          metapi_bridge_route_action: 'rotate_credential',
          metapi_bridge_continuation_number: '2',
        },
      },
    });
    await client.close();
  });

  it('reconnects with a fresh transport after the previous connection closes', async () => {
    const transports = [
      fakeTransport((message, readable) => {
        if (message.method === 'initialize') {
          readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'first' } })}\n`);
        }
      }),
      fakeTransport((message, readable) => {
        if (message.method === 'initialize') {
          readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'second' } })}\n`);
        } else if (message.method === 'thread/list') {
          readable.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
        }
      }),
    ];
    let transportIndex = 0;
    const client = new CodexAppServerControlClient({
      transportFactory: async () => transports[transportIndex++]!,
    });

    await client.connect();
    transports[0]!.readable.end();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(client.listThreads()).resolves.toEqual([]);
    expect(transportIndex).toBe(2);
    await client.close();
  });

  it('shares one initialization across concurrent callers', async () => {
    let releaseInitialize!: () => void;
    const initializeReady = new Promise<void>((resolve) => { releaseInitialize = resolve; });
    const messages: Record<string, any>[] = [];
    const transportFactory = vi.fn(async () => fakeTransport((message, readable) => {
      messages.push(message);
      if (message.method === 'initialize') {
        void initializeReady.then(() => {
          readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'shared' } })}\n`);
        });
      } else if (message.method === 'thread/list') {
        readable.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
      }
    }));
    const client = new CodexAppServerControlClient({ transportFactory });

    const first = client.listThreads();
    const second = client.listThreads();
    await new Promise((resolve) => setImmediate(resolve));
    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(messages.filter((message) => message.method === 'initialize')).toHaveLength(1);

    releaseInitialize();
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(messages.filter((message) => message.method === 'thread/list')).toHaveLength(2);
    await client.close();
  });

  it('ignores a stale transport close after a replacement connection is active', async () => {
    const first = fakeTransport((message, readable) => {
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'first' } })}\n`);
      }
    });
    const second = fakeTransport((message, readable) => {
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'second' } })}\n`);
      } else if (message.method === 'thread/list') {
        readable.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
      }
    });
    const transports = [first, second];
    const onError = vi.fn();
    let transportIndex = 0;
    const client = new CodexAppServerControlClient({
      transportFactory: async () => transports[transportIndex++]!,
      onError,
    });

    await client.connect();
    first.readable.destroy(new Error('first connection lost'));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(client.listThreads()).resolves.toEqual([]);

    first.readable.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(client.listThreads()).resolves.toEqual([]);
    expect(transportIndex).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('steers the expected active turn without applying new-turn metadata', async () => {
    const messages: Record<string, any>[] = [];
    const transport = fakeTransport((message, readable) => {
      messages.push(message);
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`);
      } else if (message.method === 'thread/resume') {
        readable.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'thread-a' } } })}\n`);
      } else if (message.method === 'turn/steer') {
        readable.write(`${JSON.stringify({ id: message.id, result: { turnId: 'turn-a' } })}\n`);
      }
    });
    const client = new CodexAppServerControlClient({ transportFactory: async () => transport });
    await expect(client.continueThread({
      taskId: 'manual-a',
      method: 'turn/steer',
      threadId: 'thread-a',
      expectedTurnId: 'turn-a',
      prompt: '先处理失败测试',
      routeAction: 'preserve',
      continuationNumber: 1,
    })).resolves.toEqual({ turnId: 'turn-a' });
    expect(messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'turn/steer',
    ]);
    expect(messages.at(-1)).toEqual(expect.objectContaining({
      method: 'turn/steer',
      params: {
        threadId: 'thread-a',
        expectedTurnId: 'turn-a',
        input: [{ type: 'text', text: '先处理失败测试' }],
      },
    }));
    expect(messages.at(-1)?.params).not.toHaveProperty('responsesapiClientMetadata');
    await client.close();
  });

  it('lists local threads for the connector dashboard without exposing messages', async () => {
    const transport = fakeTransport((message, readable) => {
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`);
      } else if (message.method === 'thread/list') {
        readable.write(`${JSON.stringify({
          id: message.id,
          result: {
            data: [{
              id: 'thread-a',
              name: '修复 Connector 看板',
              cwd: '/workspace/metapi',
              status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
              ephemeral: true,
              createdAt: 1_786_000_000,
              updatedAt: '2026-08-06T09:00:00.000Z',
              messages: [{ role: 'user', text: 'SECRET' }],
            }],
          },
        })}\n`);
      }
    });
    const client = new CodexAppServerControlClient({ transportFactory: async () => transport });
    await expect(client.listThreads()).resolves.toEqual([{
      threadId: 'thread-a',
      title: '修复 Connector 看板',
      cwd: '/workspace/metapi',
      status: 'active',
      activeFlags: ['waitingOnUserInput'],
      createdAt: '2026-08-06T07:06:40.000Z',
      updatedAt: '2026-08-06T09:00:00.000Z',
      ephemeral: true,
    }]);
    await client.close();
  });

  it('reads the newest persisted completion with the final assistant reply', async () => {
    const messages: Record<string, any>[] = [];
    const transport = fakeTransport((message, readable) => {
      messages.push(message);
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`);
      } else if (message.method === 'thread/read') {
        readable.write(`${JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: 'thread-a',
              turns: [{
                id: 'turn-old',
                status: 'completed',
                items: [{ type: 'agentMessage', phase: 'final_answer', text: '旧回复' }],
              }, {
                id: 'turn-current',
                status: 'inProgress',
                items: [{ type: 'agentMessage', text: '处理中' }],
              }, {
                id: 'turn-latest',
                status: 'completed',
                items: [
                  { type: 'agentMessage', phase: 'commentary', text: '收尾中' },
                  { type: 'agentMessage', phase: 'final_answer', text: '最终回复' },
                ],
              }],
            },
          },
        })}\n`);
      }
    });
    const client = new CodexAppServerControlClient({ transportFactory: async () => transport });
    await expect(client.readLatestCompletedTurn('thread-a')).resolves.toEqual({
      threadId: 'thread-a',
      turnId: 'turn-latest',
      status: 'completed',
      assistantMessage: '最终回复',
      failure: null,
    });
    expect(messages.at(-1)).toMatchObject({
      method: 'thread/read',
      params: { threadId: 'thread-a', includeTurns: true },
    });
    await client.close();
  });

  it('normalizes lifecycle metadata and only forwards the final assistant reply', () => {
    expect(normalizeAppServerControlNotification({
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-a',
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        activeTurnId: 'turn-status-a',
        prompt: 'SECRET PROMPT',
      },
    })).toEqual({
      kind: 'thread_status',
      threadId: 'thread-a',
      status: 'active',
      activeFlags: ['waitingOnApproval'],
      activeTurnId: 'turn-status-a',
    });
    expect(normalizeAppServerControlNotification({
      method: 'error',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-a',
        willRetry: false,
        error: {
          message: 'rate limited',
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        },
        diff: 'SECRET DIFF',
      },
    })).toMatchObject({
      kind: 'error',
      threadId: 'thread-a',
      turnId: 'turn-a',
      failure: { message: 'rate limited', willRetry: false },
    });
    expect(normalizeAppServerControlNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-a', delta: 'SECRET OUTPUT' },
    })).toBeNull();
    expect(normalizeAppServerControlNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-a',
        turn: {
          id: 'turn-a',
          status: 'completed',
          items: [
            { id: 'user-a', type: 'userMessage', content: [{ type: 'text', text: 'SECRET PROMPT' }] },
            { id: 'agent-a', type: 'agentMessage', phase: 'commentary', text: '处理中' },
            { id: 'tool-a', type: 'commandExecution', command: 'SECRET COMMAND' },
            { id: 'agent-b', type: 'agentMessage', phase: 'final_answer', text: '你好' },
          ],
        },
      },
    })).toEqual({
      kind: 'turn_completed',
      threadId: 'thread-a',
      turnId: 'turn-a',
      status: 'completed',
      assistantMessage: '你好',
      failure: null,
    });
  });

  it('captures safe server-request params, writes one response, and observes authoritative resolution', async () => {
    const messages: Record<string, any>[] = [];
    const requests: Record<string, any>[] = [];
    const notifications: Record<string, any>[] = [];
    const transport = fakeTransport((message, readable) => {
      messages.push(message);
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`);
      }
    });
    const client = new CodexAppServerControlClient({
      transportFactory: async () => transport,
      onServerRequest: async (request, responder) => {
        requests.push(request);
        responder.respond({ decision: 'accept' });
        responder.respond({ decision: 'decline' });
      },
      onNotification: async (event) => {
        notifications.push(event);
      },
    });
    await client.connect();

    transport.readable.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-a',
        itemId: 'item-a',
        command: 'npm test',
        availableDecisions: ['accept', 'decline'],
      },
    })}\n`);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      requestId: 77,
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      params: {
        command: 'npm test',
        availableDecisions: ['accept', 'decline'],
      },
    });
    expect(messages.filter((message) => message.id === 77)).toEqual([
      { jsonrpc: '2.0', id: 77, result: { decision: 'accept' } },
    ]);

    transport.readable.write(`${JSON.stringify({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-a', requestId: 77 },
    })}\n`);
    await vi.waitFor(() => expect(notifications).toContainEqual({
      kind: 'server_request_resolved',
      threadId: 'thread-a',
      sourceRequestId: '77',
    }));
    await client.close();
  });

  it('does not send a delayed server-request response through a replacement connection', async () => {
    let delayedResponder: { respond(result: unknown): void } | null = null;
    const firstMessages: Record<string, any>[] = [];
    const secondMessages: Record<string, any>[] = [];
    const first = fakeTransport((message, readable) => {
      firstMessages.push(message);
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'first' } })}\n`);
      }
    });
    const second = fakeTransport((message, readable) => {
      secondMessages.push(message);
      if (message.method === 'initialize') {
        readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'second' } })}\n`);
      } else if (message.method === 'thread/list') {
        readable.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
      }
    });
    const transports = [first, second];
    let transportIndex = 0;
    const client = new CodexAppServerControlClient({
      transportFactory: async () => transports[transportIndex++]!,
      onServerRequest: async (_request, responder) => {
        delayedResponder = responder;
      },
    });
    await client.connect();
    first.readable.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 88,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a' },
    })}\n`);
    await vi.waitFor(() => expect(delayedResponder).not.toBeNull());

    first.readable.end();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(client.listThreads()).resolves.toEqual([]);
    delayedResponder!.respond({ decision: 'accept' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(firstMessages.filter((message) => message.id === 88)).toEqual([]);
    expect(secondMessages.filter((message) => message.id === 88)).toEqual([]);
    await client.close();
  });
});
