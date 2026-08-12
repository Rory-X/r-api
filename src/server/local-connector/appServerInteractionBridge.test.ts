import { describe, expect, it, vi } from 'vitest';
import {
  AppServerInteractionBridge,
  interactionKindForAppServerMethod,
} from './appServerInteractionBridge.js';

describe('App Server Interaction Bridge', () => {
  it('normalizes every supported App Server request family', () => {
    expect(interactionKindForAppServerMethod('item/commandExecution/requestApproval')).toBe('command_approval');
    expect(interactionKindForAppServerMethod('item/fileChange/requestApproval')).toBe('file_change_approval');
    expect(interactionKindForAppServerMethod('item/permissions/requestApproval')).toBe('permissions_approval');
    expect(interactionKindForAppServerMethod('item/tool/requestUserInput')).toBe('user_input');
    expect(interactionKindForAppServerMethod('tool/requestUserInput')).toBe('user_input');
    expect(interactionKindForAppServerMethod('mcpServer/elicitation/request')).toBe('mcp_elicitation');
    expect(interactionKindForAppServerMethod('item/tool/call')).toBeNull();
  });

  it('submits, polls, responds once, and reports source resolution with stable deliveries', async () => {
    const createInteractionRequest = vi.fn(async () => ({
      created: true,
      interaction: { requestId: 'interaction-a', status: 'pending' as const, expiresAtMs: Date.now() + 60_000 },
    }));
    const claimInteractionResponse = vi.fn()
      .mockResolvedValueOnce({
        ready: false,
        responsePayload: null,
        interaction: { requestId: 'interaction-a', status: 'pending', expiresAtMs: Date.now() + 60_000 },
      })
      .mockResolvedValue({
        ready: true,
        responsePayload: { decision: 'accept' },
        interaction: { requestId: 'interaction-a', status: 'response_pending', expiresAtMs: Date.now() + 60_000 },
      });
    const resolveInteractionRequest = vi.fn(async () => ({
      requestId: 'interaction-a',
      status: 'resolved' as const,
      expiresAtMs: Date.now() + 60_000,
    }));
    const responder = { respond: vi.fn(), reject: vi.fn() };
    const bridge = new AppServerInteractionBridge({
      createInteractionRequest,
      claimInteractionResponse,
      resolveInteractionRequest,
    } as any, 'connection-a', 10);

    const task = bridge.handleRequest({
      requestId: 77,
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-a',
        itemId: 'item-a',
        command: 'npm test',
      },
    }, responder);

    await vi.waitFor(() => expect(responder.respond).toHaveBeenCalledWith({ decision: 'accept' }));
    expect(responder.respond).toHaveBeenCalledTimes(1);
    expect(responder.reject).not.toHaveBeenCalled();
    expect(createInteractionRequest).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'connection-a',
      sourceRequestId: 77,
      kind: 'command_approval',
      requestPayload: expect.objectContaining({ command: 'npm test' }),
    }));
    const responseDeliveryId = claimInteractionResponse.mock.calls[0]?.[0]?.deliveryId;
    expect(responseDeliveryId).toMatch(/^interaction-response:/);
    expect(claimInteractionResponse.mock.calls.every(
      ([input]) => input.deliveryId === responseDeliveryId,
    )).toBe(true);

    expect(bridge.handleNotification({
      kind: 'server_request_resolved',
      threadId: 'thread-a',
      sourceRequestId: '77',
    })).toBe(true);
    await task;
    expect(resolveInteractionRequest).toHaveBeenCalledTimes(1);
    expect(resolveInteractionRequest).toHaveBeenCalledWith({
      requestId: 'interaction-a',
      deliveryId: expect.stringMatching(/^interaction-resolved:/),
    });
    await bridge.close();
  });

  it('rejects unsupported server requests instead of leaving App Server blocked', async () => {
    const responder = { respond: vi.fn(), reject: vi.fn() };
    const bridge = new AppServerInteractionBridge({} as any, 'connection-a', 10);
    await bridge.handleRequest({
      requestId: 'dynamic-a',
      method: 'item/tool/call',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      params: {},
    }, responder);
    expect(responder.respond).not.toHaveBeenCalled();
    expect(responder.reject).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Metapi 不支持 App Server 请求: item/tool/call',
    }));
    await bridge.close();
  });
});
