import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { createCipheriv, createHash } from 'node:crypto';

type DbModule = typeof import('../db/index.js');
type ConnectorService = typeof import('./localConnectorService.js');
type InteractionService = typeof import('./interactionRequestService.js');
type FeishuService = typeof import('./feishuInteractionAdapterService.js');
type BridgeService = typeof import('./bridgeContinuationService.js');
type ThreadService = typeof import('./localConnectorThreadService.js');

describe('Feishu Interaction Adapter service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let connector: ConnectorService;
  let interaction: InteractionService;
  let feishu: FeishuService;
  let bridge: BridgeService;
  let threads: ThreadService;
  let dataDir = '';
  let deviceId = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-feishu-interaction-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    connector = await import('./localConnectorService.js');
    interaction = await import('./interactionRequestService.js');
    feishu = await import('./feishuInteractionAdapterService.js');
    bridge = await import('./bridgeContinuationService.js');
    threads = await import('./localConnectorThreadService.js');
  });

  beforeEach(async () => {
    feishu.feishuInteractionAdapterInternals.tenantTokenCache.clear();
    await db.delete(schema.interactionActionTickets).run();
    await db.delete(schema.interactionCardUpdates).run();
    await db.delete(schema.interactionDispatches).run();
    await db.delete(schema.interactionPromptCards).run();
    await db.delete(schema.feishuTopicBindings).run();
    await db.delete(schema.interactionAdapters).run();
    await db.delete(schema.interactionEvents).run();
    await db.delete(schema.interactionRequests).run();
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorActions).run();
    await db.delete(schema.localConnectorThreads).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorDevices).run();
    await db.delete(schema.credentialVaultItems).run();

    const pairing = await connector.createLocalConnectorPairing({
      deviceName: 'MacBook',
      scopes: ['app_server.control'],
    });
    const claimed = await connector.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
    });
    deviceId = claimed.device.id;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function createAdapter(options: { encryptKey?: string } = {}) {
    return feishu.createFeishuInteractionAdapter({
      deviceId,
      name: 'Operations',
      appId: 'cli_test_app',
      appSecret: 'app-secret-value',
      verificationToken: 'verification-token-value',
      encryptKey: options.encryptKey,
      apiBaseUrl: 'https://open.feishu.cn',
      receiveIdType: 'chat_id',
      receiveId: 'oc_chat_1',
      consoleBaseUrl: 'https://metapi.example.com',
      operatorAllowlist: ['open_id:ou_allowed'],
    });
  }

  async function createApproval(sourceRequestId = 'request-1') {
    await threads.recordLocalConnectorThreadEvent({
      deviceId,
      event: {
        kind: 'thread_status',
        threadId: 'thread-a',
        title: 'Dependency health check',
        status: 'idle',
      },
    });
    return interaction.createInteractionRequest({
      deviceId,
      connectionId: 'connection-a',
      sourceRequestId,
      kind: 'command_approval',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      requestPayload: {
        command: 'npm test',
        cwd: '/workspace',
        availableDecisions: ['accept', 'decline'],
      },
      ttlMs: 60_000,
    });
  }

  function deliveredFetch() {
    return vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7_200,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { message_id: 'om_message_1' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }

  function ticketFromMessageFetch(fetchMock: ReturnType<typeof deliveredFetch>, label: string): string {
    const request = fetchMock.mock.calls[1]?.[1] as { body?: string };
    const messageBody = JSON.parse(request.body || '{}');
    const card = JSON.parse(messageBody.content || '{}');
    const actionElement = card.elements.find((item: any) => item.tag === 'action');
    const button = actionElement.actions.find((item: any) => item.text?.content === label);
    return button.value.metapi_ticket;
  }

  function promptTicketFromMessageFetch(fetchMock: ReturnType<typeof deliveredFetch>, label: string): string {
    const request = fetchMock.mock.calls[1]?.[1] as { body?: string };
    const messageBody = JSON.parse(request.body || '{}');
    const card = JSON.parse(messageBody.content || '{}');
    const form = card.elements.find((item: any) => item.tag === 'form');
    const button = form.elements.find((item: any) => item.text?.content === label);
    return button.value.metapi_ticket;
  }

  function cardFromFetchCall(fetchMock: ReturnType<typeof deliveredFetch>, callIndex: number) {
    const request = fetchMock.mock.calls[callIndex]?.[1] as { body?: string };
    const body = JSON.parse(request.body || '{}');
    return JSON.parse(body.content || '{}');
  }

  function encryptedCallback(encryptKey: string, body: Record<string, unknown>) {
    const iv = Buffer.from('0123456789abcdef');
    const key = createHash('sha256').update(encryptKey).digest();
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([
      iv,
      cipher.update(JSON.stringify(body), 'utf8'),
      cipher.final(),
    ]).toString('base64');
    const envelope = { encrypt: encrypted };
    const rawBody = `\n${JSON.stringify(envelope)}\n`;
    const timestamp = '1785855600';
    const nonce = 'nonce-encrypted-callback';
    const signature = createHash('sha256')
      .update(timestamp)
      .update(nonce)
      .update(encryptKey)
      .update(rawBody)
      .digest('hex');
    return {
      envelope,
      security: { rawBody, timestamp, nonce, signature },
    };
  }

  it('stores secrets in the encrypted Vault and returns only safe adapter state', async () => {
    const adapter = await createAdapter();
    expect(adapter).toMatchObject({
      kind: 'feishu',
      name: 'Operations',
      appId: 'cli_test_app',
      receiveId: 'oc_chat_1',
      operatorAllowlist: ['open_id:ou_allowed'],
      secretsConfigured: { appSecret: true, verificationToken: true },
    });
    expect(adapter).not.toHaveProperty('appSecret');
    expect(adapter).not.toHaveProperty('verificationToken');

    const vaultRows = await db.select().from(schema.credentialVaultItems).all();
    expect(vaultRows).toHaveLength(2);
    expect(vaultRows.every((row) => row.kind === 'integration_secret')).toBe(true);
    expect(vaultRows.map((row) => row.ciphertext).join(' ')).not.toContain('app-secret-value');
  });

  it('sends a collapsed card notification through the adapter bound to the connector', async () => {
    const adapter = await createAdapter();
    const fetchMock = deliveredFetch();

    await expect(feishu.sendFeishuTextNotification({
      deviceId,
      title: 'Local Connector · Codex 会话已完成',
      message: [
        '会话名称：Local Connector',
        'Thread thread-a',
        'Turn turn-1',
        '状态: completed',
        '助手回复：',
        '已完成连接检查，通知与话题链路均正常。',
        '下一步可以直接在该话题继续发送消息。',
      ].join('\n'),
      level: 'info',
      occurredAt: '2026-08-11T05:00:00.000Z',
      fetchImpl: fetchMock as any,
    })).resolves.toMatchObject({ adapterId: adapter.id, messageIds: ['om_message_1'] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, request] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.toString()).toContain('/open-apis/im/v1/messages?receive_id_type=chat_id');
    const payload = JSON.parse(String(request.body || '{}')) as {
      receive_id?: string;
      msg_type?: string;
      content?: string;
      uuid?: string;
    };
    expect(payload).toMatchObject({ receive_id: 'oc_chat_1', msg_type: 'interactive' });
    expect(payload.uuid).toMatch(/^[a-f0-9]{50}$/);
    const card = JSON.parse(payload.content || '{}');
    expect(card).toMatchObject({
      schema: '2.0',
      header: { template: 'green', title: { content: 'Local Connector · 已完成' } },
    });
    expect(card.header.title.content.length).toBeLessThanOrEqual(72);
    expect(card.body.elements[0].content).toContain('**最终回复**');
    expect(card.body.elements[0].content).toContain('已完成连接检查');
    expect(card.body.elements[0].content).toContain('下一步可以直接在该话题继续发送消息');
    expect(card.body.elements[0].content).not.toContain('thread-a');
    expect(card.body.elements[0].content).not.toContain('turn-1');
    expect(card.body.elements[1]).toMatchObject({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { content: '完整回复与会话信息' } },
    });
    expect(card.body.elements[1].elements[0]).toMatchObject({
      tag: 'markdown',
      content: expect.stringContaining('Turn turn-1'),
    });
    const promptForm = card.body.elements.find((item: any) => item.tag === 'form');
    expect(promptForm).toMatchObject({ name: 'metapi_topic_prompt_form' });
    expect(promptForm.elements.find((item: any) => item.tag === 'input')).toMatchObject({
      name: 'metapi_prompt',
      input_type: 'multiline_text',
      max_length: 1_000,
    });
    expect(promptForm.elements.find((item: any) => item.tag === 'button')).toMatchObject({
      name: 'metapi_topic_prompt_next',
      form_action_type: 'submit',
      behaviors: [{
        type: 'callback',
        value: { metapi_topic_prompt: expect.stringMatching(/^mtp_topic_/) },
      }],
    });

    const binding = await db.select().from(schema.feishuTopicBindings).get();
    expect(binding).toMatchObject({
      adapterId: adapter.id,
      deviceId,
      codexThreadId: 'thread-a',
      rootMessageId: 'om_message_1',
      lastMessageId: 'om_message_1',
    });
  });

  it('replies subsequent completion cards into the unique Feishu topic for the Codex thread', async () => {
    const adapter = await createAdapter();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7_200,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { message_id: 'om_topic_root' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: {
          message_id: 'om_topic_reply',
          root_id: 'om_topic_root',
          thread_id: 'omt_codex_thread_a',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await feishu.sendFeishuCardNotification({
      deviceId,
      title: 'Codex 会话已完成',
      message: '线程 ID：thread-a\n轮次 ID：turn-1\n状态：completed',
      level: 'info',
      occurredAt: '2026-08-11T05:00:00.000Z',
      fetchImpl: fetchMock as any,
    });
    await expect(feishu.sendFeishuCardNotification({
      deviceId,
      title: 'Codex 会话已完成',
      message: '线程 ID：thread-a\n轮次 ID：turn-2\n状态：completed',
      level: 'info',
      occurredAt: '2026-08-11T05:10:00.000Z',
      fetchImpl: fetchMock as any,
    })).resolves.toMatchObject({ adapterId: adapter.id, messageIds: ['om_topic_reply'] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [replyUrl, replyRequest] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(replyUrl).toContain('/open-apis/im/v1/messages/om_topic_root/reply');
    expect(JSON.parse(String(replyRequest.body || '{}'))).toMatchObject({
      msg_type: 'interactive',
      reply_in_thread: true,
      uuid: expect.stringMatching(/^[a-f0-9]{50}$/),
    });
    const binding = await db.select().from(schema.feishuTopicBindings).get();
    expect(binding).toMatchObject({
      adapterId: adapter.id,
      codexThreadId: 'thread-a',
      rootMessageId: 'om_topic_root',
      feishuThreadId: 'omt_codex_thread_a',
      lastMessageId: 'om_topic_reply',
    });
  });

  it('retries an uncertain root send with the same binding and Feishu uuid', async () => {
    await createAdapter();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7_200,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockRejectedValueOnce(new Error('socket closed after request write'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { message_id: 'om_recovered_root' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const input = {
      deviceId,
      title: 'Codex 会话已完成',
      message: '线程 ID：thread-retry\n轮次 ID：turn-1\n状态：completed',
      level: 'info' as const,
      occurredAt: '2026-08-11T05:00:00.000Z',
      fetchImpl: fetchMock as any,
    };

    await expect(feishu.sendFeishuCardNotification(input)).rejects.toThrow('投递结果未知');
    const pending = await db.select().from(schema.feishuTopicBindings).get();
    expect(pending).toMatchObject({ codexThreadId: 'thread-retry', rootMessageId: null });

    await expect(feishu.sendFeishuCardNotification(input)).resolves.toMatchObject({
      messageIds: ['om_recovered_root'],
    });
    const firstBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body || '{}'));
    const retryBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body || '{}'));
    expect(retryBody.uuid).toBe(firstBody.uuid);
    expect(retryBody.content).toBe(firstBody.content);
    const recovered = await db.select().from(schema.feishuTopicBindings).get();
    expect(recovered).toMatchObject({
      codexThreadId: 'thread-retry',
      rootMessageId: 'om_recovered_root',
      lastMessageId: 'om_recovered_root',
    });
  });

  it('prevents one Feishu thread from binding to two Codex threads', async () => {
    const adapter = await createAdapter();
    const nowIso = '2026-08-11T05:00:00.000Z';
    await db.insert(schema.feishuTopicBindings).values({
      id: '11111111-1111-4111-8111-111111111111',
      adapterId: adapter.id,
      deviceId,
      codexThreadId: 'thread-a',
      rootMessageId: 'om_root_a',
      feishuThreadId: 'omt_shared',
      lastMessageId: 'om_root_a',
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();

    await expect(db.insert(schema.feishuTopicBindings).values({
      id: '22222222-2222-4222-8222-222222222222',
      adapterId: adapter.id,
      deviceId,
      codexThreadId: 'thread-b',
      rootMessageId: 'om_root_b',
      feishuThreadId: 'omt_shared',
      lastMessageId: 'om_root_b',
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run()).rejects.toThrow();
  });

  it('reuses the completed-card Prompt form and deduplicates callback retries by event id', async () => {
    const adapter = await createAdapter();
    const fetchMock = deliveredFetch();
    await feishu.sendFeishuCardNotification({
      deviceId,
      title: 'Codex 会话已完成',
      message: '线程 ID：thread-a\n轮次 ID：turn-1\n状态：completed',
      level: 'info',
      occurredAt: '2026-08-11T05:00:00.000Z',
      fetchImpl: fetchMock as any,
    });
    const card = cardFromFetchCall(fetchMock, 1);
    const form = card.body.elements.find((item: any) => item.tag === 'form');
    const button = form.elements.find((item: any) => item.tag === 'button');
    const topicToken = button.behaviors[0].value.metapi_topic_prompt;
    await threads.recordLocalConnectorThreadEvent({
      deviceId,
      event: {
        kind: 'thread_status',
        threadId: 'thread-a',
        status: 'idle',
        observationSource: 'connector_app_server',
        controlState: 'available',
      },
    });
    const callback = {
      header: {
        token: 'verification-token-value',
        event_type: 'card.action.trigger',
        event_id: 'evt_topic_prompt_1',
      },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: {
          value: { metapi_topic_prompt: topicToken },
          form_value: { metapi_prompt: '继续检查话题通知链路' },
        },
        context: { open_message_id: 'om_message_1', open_chat_id: 'oc_chat_1' },
      },
    };

    await expect(feishu.handleFeishuInteractionCallback(adapter.id, callback)).resolves.toEqual({
      toast: { type: 'success', content: 'Prompt 已进入会话 thread-a' },
    });
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, callback)).resolves.toEqual({
      toast: { type: 'success', content: '该 Prompt 已处理' },
    });

    const firstTasks = await bridge.listBridgeContinuationTasks({ deviceId });
    expect(firstTasks).toHaveLength(1);
    expect(firstTasks[0]).toMatchObject({
      state: {
        threadId: 'thread-a',
        status: 'backoff',
        submissionMode: 'start_next',
        pendingMethod: 'turn/start',
        pendingPrompt: '继续检查话题通知链路',
      },
      requestedBy: 'feishu:open_id:ou_allowed',
      sourceAdapterId: adapter.id,
    });

    const secondCallback = structuredClone(callback);
    secondCallback.header.event_id = 'evt_topic_prompt_2';
    secondCallback.event.action.form_value.metapi_prompt = '再发起一轮验证';
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, secondCallback)).resolves.toEqual({
      toast: { type: 'success', content: 'Prompt 已进入会话 thread-a' },
    });
    const tasks = await bridge.listBridgeContinuationTasks({ deviceId });
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.state.pendingPrompt).toBe('再发起一轮验证');
  });

  it('queues ordinary text sent in the bound Feishu topic and deduplicates message retries', async () => {
    const adapter = await createAdapter();
    const fetchMock = deliveredFetch();
    await feishu.sendFeishuCardNotification({
      deviceId,
      title: 'Codex 任务已完成',
      message: '线程 ID：thread-topic-message\n轮次 ID：turn-1\n状态：completed',
      level: 'info',
      occurredAt: '2026-08-11T05:00:00.000Z',
      fetchImpl: fetchMock as any,
    });
    await threads.recordLocalConnectorThreadEvent({
      deviceId,
      event: {
        kind: 'thread_status',
        threadId: 'thread-topic-message',
        status: 'idle',
        observationSource: 'connector_app_server',
        controlState: 'available',
      },
    });
    const messageCallback = {
      header: {
        token: 'verification-token-value',
        event_type: 'im.message.receive_v1',
        event_id: 'evt_topic_message_1',
      },
      event: {
        sender: {
          sender_type: 'user',
          sender_id: { open_id: 'ou_allowed' },
        },
        message: {
          message_id: 'om_topic_user_1',
          root_id: 'om_message_1',
          thread_id: 'omt_topic_message',
          message_type: 'text',
          content: JSON.stringify({ text: '请继续检查这个会话的结果' }),
        },
      },
    };
    await expect(feishu.handleFeishuLongConnectionCallback({
      adapterId: adapter.id,
      eventType: 'im.message.receive_v1',
      eventId: 'evt_topic_message_1',
      event: messageCallback.event,
    })).resolves.toMatchObject({
      success: true,
      queued: true,
      replayed: false,
      codexThreadId: 'thread-topic-message',
    });
    const tasks = await bridge.listBridgeContinuationTasks({ deviceId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      state: {
        taskKind: 'manual_prompt',
        submissionMode: 'start_next',
        status: 'backoff',
        pendingMethod: 'turn/start',
        pendingPrompt: '请继续检查这个会话的结果',
      },
    });

    await expect(feishu.handleFeishuLongConnectionCallback({
      adapterId: adapter.id,
      eventType: 'im.message.receive_v1',
      eventId: 'evt_topic_message_retry',
      event: messageCallback.event,
    })).resolves.toMatchObject({
      success: true,
      queued: true,
      replayed: true,
      taskId: tasks[0]?.state.taskId,
    });
    expect(await bridge.listBridgeContinuationTasks({ deviceId })).toHaveLength(1);
    expect(await db.select().from(schema.feishuTopicBindings).get()).toMatchObject({
      rootMessageId: 'om_message_1',
      feishuThreadId: 'omt_topic_message',
      lastMessageId: 'om_topic_user_1',
    });
  });

  it('ignores unbound topics and messages sent by the Feishu app itself', async () => {
    const adapter = await createAdapter();
    const base = {
      header: {
        token: 'verification-token-value',
        event_type: 'im.message.receive_v1',
      },
      event: {
        sender: { sender_type: 'app', sender_id: { open_id: 'ou_allowed' } },
        message: {
          message_id: 'om_unbound_app_message',
          root_id: 'om_unknown_root',
          message_type: 'text',
          content: JSON.stringify({ text: '不要回环' }),
        },
      },
    };
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, base)).resolves.toMatchObject({
      success: true,
      ignored: true,
      reason: 'app_message',
    });
    const userMessage = structuredClone(base);
    userMessage.event.sender.sender_type = 'user';
    userMessage.event.message.message_id = 'om_unbound_user_message';
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, userMessage)).resolves.toMatchObject({
      success: true,
      ignored: true,
      reason: 'topic_not_bound',
    });
    expect(await bridge.listBridgeContinuationTasks({ deviceId })).toHaveLength(0);
  });

  it('delivers a card and consumes one signed action exactly once for an allowed operator', async () => {
    const adapter = await createAdapter();
    const created = await createApproval();
    const fetchMock = deliveredFetch();

    const pass = await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    expect(pass).toMatchObject({ reconciled: 1, delivered: 1, unknown: 0 });
    const card = cardFromFetchCall(fetchMock, 1);
    expect(card.header.title.content).toBe('Dependency health check · 命令审批');
    expect(card.header.title.content.length).toBeLessThanOrEqual(72);
    const summary = card.elements.find((item: any) => item.tag === 'div')?.text?.content || '';
    expect(summary).toContain('**待执行命令**');
    expect(summary).toContain('npm test');
    expect(summary).toContain('**工作目录**  /workspace');
    expect(summary).not.toContain('thread-a');
    expect(summary).not.toContain('turn-a');
    expect(card.elements.filter((item: any) => item.tag === 'note')).toHaveLength(0);
    const promptForm = card.elements.find((item: any) => item.tag === 'form');
    const promptInput = promptForm.elements.find((item: any) => item.tag === 'input');
    expect(promptInput.max_length).toBe(1_000);
    const allowTicket = ticketFromMessageFetch(fetchMock, '允许');
    expect(allowTicket).toMatch(/^mit_/);

    await expect(feishu.handleFeishuInteractionCallback(adapter.id, {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_denied' },
        action: { value: { metapi_ticket: allowTicket } },
      },
    })).rejects.toThrow('白名单');

    const callbackEvent = {
      operator: { open_id: 'ou_allowed' },
      action: { value: { metapi_ticket: allowTicket } },
    };
    await expect(feishu.handleFeishuLongConnectionCallback({
      adapterId: adapter.id,
      eventType: 'card.action.trigger',
      eventId: 'evt_ws_approval_1',
      event: callbackEvent,
    })).resolves.toMatchObject({
      toast: { type: 'success', content: '已提交到 Metapi' },
    });
    await expect(feishu.handleFeishuLongConnectionCallback({
      adapterId: adapter.id,
      eventType: 'card.action.trigger',
      eventId: 'evt_ws_approval_1',
      event: callbackEvent,
    })).resolves.toMatchObject({
      toast: { type: 'success', content: '该操作已处理' },
    });

    const stored = await interaction.getInteractionRequest(created.request.state.requestId);
    expect(stored?.state).toMatchObject({
      status: 'response_pending',
      responsePayload: { decision: 'accept' },
      responseSource: 'im',
      responseOperatorId: 'feishu:open_id:ou_allowed',
    });
    const tickets = await db.select().from(schema.interactionActionTickets).all();
    expect(tickets.filter((ticket) => ticket.status === 'consumed')).toHaveLength(1);
    expect(tickets.filter((ticket) => ticket.status === 'cancelled')).toHaveLength(1);
  });

  it('creates dispatches only for interactions owned by the adapter Connector', async () => {
    const adapter = await createAdapter();
    const ownerInteraction = await createApproval('request-owner');
    const pairing = await connector.createLocalConnectorPairing({
      deviceName: 'Other Mac',
      scopes: ['app_server.control'],
    });
    const other = await connector.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
    });
    const otherInteraction = await interaction.createInteractionRequest({
      deviceId: other.device.id,
      connectionId: 'connection-other',
      sourceRequestId: 'request-other',
      kind: 'command_approval',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-other',
      requestPayload: { command: 'npm test' },
      ttlMs: 60_000,
    });
    await expect(feishu.updateFeishuInteractionAdapter(adapter.id, {
      deviceId: other.device.id,
    })).rejects.toThrow(/不能迁移/);

    await expect(feishu.reconcileFeishuInteractionDispatches()).resolves.toBe(1);
    const dispatches = await feishu.listFeishuInteractionDispatches({ adapterId: adapter.id });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].interactionId).toBe(ownerInteraction.request.state.requestId);
    expect(dispatches[0].interactionId).not.toBe(otherInteraction.request.state.requestId);

    await db.update(schema.interactionAdapters).set({ deviceId: null })
      .where(eq(schema.interactionAdapters.id, adapter.id)).run();
    const fetchMock = vi.fn();
    const pass = await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    expect(pass.cancelled).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers Feishu URL verification challenges after validating the shared token', async () => {
    const adapter = await createAdapter();
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, {
      type: 'url_verification',
      token: 'verification-token-value',
      challenge: 'challenge-value',
    })).resolves.toEqual({ challenge: 'challenge-value' });
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, {
      type: 'url_verification',
      token: 'wrong-token',
      challenge: 'challenge-value',
    })).rejects.toThrow('Verification Token');
  });

  it('validates and decrypts Encrypt Key callbacks before processing them', async () => {
    const encryptKey = 'encrypt-key-value';
    const rotatedEncryptKey = 'encrypt-key-value-rotated';
    const adapter = await createAdapter({ encryptKey });
    expect(adapter.secretsConfigured.encryptKey).toBe(true);
    const vaultRows = await db.select().from(schema.credentialVaultItems).all();
    expect(vaultRows).toHaveLength(3);
    expect(JSON.stringify(vaultRows)).not.toContain(encryptKey);

    const challenge = encryptedCallback(encryptKey, {
      type: 'url_verification',
      token: 'verification-token-value',
      challenge: 'encrypted-challenge',
    });
    await expect(feishu.handleFeishuInteractionCallback(
      adapter.id,
      challenge.envelope,
      new Date(),
      challenge.security,
    )).resolves.toEqual({ challenge: 'encrypted-challenge' });
    await expect(feishu.handleFeishuInteractionCallback(
      adapter.id,
      challenge.envelope,
      new Date(),
      { ...challenge.security, signature: '0'.repeat(64) },
    )).rejects.toThrow('签名');

    const rotated = await feishu.updateFeishuInteractionAdapter(adapter.id, {
      encryptKey: rotatedEncryptKey,
    });
    expect(rotated.secretsConfigured.encryptKey).toBe(true);
    await expect(feishu.handleFeishuInteractionCallback(
      adapter.id,
      challenge.envelope,
      new Date(),
      challenge.security,
    )).rejects.toThrow('签名');
    const encryptKeyRows = (await db.select().from(schema.credentialVaultItems).all())
      .filter((row) => row.name.includes('encrypt_key'));
    expect(encryptKeyRows.map((row) => row.status).sort()).toEqual(['active', 'revoked']);

    const created = await createApproval('request-encrypted-action');
    const fetchMock = deliveredFetch();
    await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    const allowTicket = ticketFromMessageFetch(fetchMock, '允许');
    const action = encryptedCallback(rotatedEncryptKey, {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: { value: { metapi_ticket: allowTicket } },
      },
    });
    await expect(feishu.handleFeishuInteractionCallback(
      adapter.id,
      action.envelope,
      new Date(),
      action.security,
    )).resolves.toMatchObject({ toast: { type: 'success', content: '已提交到 Metapi' } });
    const stored = await interaction.getInteractionRequest(created.request.state.requestId);
    expect(stored?.state).toMatchObject({ status: 'response_pending', responsePayload: { decision: 'accept' } });
  });

  it('holds delivery_unknown for manual review instead of automatically duplicating cards', async () => {
    await createAdapter();
    await createApproval('request-unknown');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7_200,
      }), { status: 200 }))
      .mockRejectedValueOnce(new Error('socket closed after write'));

    const first = await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    expect(first.unknown).toBe(1);
    const second = await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    expect(second.delivered).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const dispatch = (await feishu.listFeishuInteractionDispatches())[0];
    expect(dispatch?.status).toBe('delivery_unknown');
    await expect(feishu.retryFeishuInteractionDispatch(dispatch.id)).resolves.toBe(true);
  });

  it('patches a delivered interaction card for response_pending and again for resolved', async () => {
    const adapter = await createAdapter();
    const created = await createApproval('request-card-update');
    const fetchMock = deliveredFetch();
    await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    const allowTicket = ticketFromMessageFetch(fetchMock, '允许');
    await feishu.handleFeishuInteractionCallback(adapter.id, {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: { value: { metapi_ticket: allowTicket } },
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    await expect(feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any }))
      .resolves.toMatchObject({ cardUpdatesReconciled: 1, cardUpdated: 1, cardUpdateUnknown: 0 });
    expect(fetchMock.mock.calls[2]?.[0].toString()).toContain('/open-apis/im/v1/messages/om_message_1');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe('PATCH');
    const pendingCard = cardFromFetchCall(fetchMock, 2);
    expect(pendingCard.header.title.content).toBe('Dependency health check · 已提交');
    expect(pendingCard.elements.some((element: any) => element.tag === 'action' || element.tag === 'form')).toBe(false);
    expect(JSON.stringify(pendingCard)).not.toContain('thread-a');
    expect(JSON.stringify(pendingCard)).not.toContain('turn-a');
    expect(JSON.stringify(pendingCard)).not.toContain(created.request.state.requestId);
    const pendingDispatch = (await feishu.listFeishuInteractionDispatches({
      interactionId: created.request.state.requestId,
    }))[0];
    expect(pendingDispatch.cardUpdate).toMatchObject({
      targetStatus: 'response_pending',
      status: 'delivered',
      attemptCount: 1,
    });
    const pendingTickets = await db.select().from(schema.interactionActionTickets)
      .where(eq(schema.interactionActionTickets.status, 'pending')).all();
    expect(pendingTickets).toHaveLength(0);

    await interaction.resolveInteractionSource({
      requestId: created.request.state.requestId,
      deviceId,
      deliveryId: 'source-resolved-card-update',
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    await expect(feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any }))
      .resolves.toMatchObject({ cardUpdatesReconciled: 1, cardUpdated: 1 });
    const resolvedCard = cardFromFetchCall(fetchMock, 3);
    expect(resolvedCard.header.title.content).toBe('Dependency health check · 已完成');
    expect(resolvedCard.elements.some((element: any) => element.tag === 'action' || element.tag === 'form')).toBe(false);
    const updates = await db.select().from(schema.interactionCardUpdates)
      .where(eq(schema.interactionCardUpdates.dispatchId, pendingDispatch.id)).all();
    expect(updates).toHaveLength(2);
    expect(updates.every((update) => update.status === 'delivered')).toBe(true);
  });

  it('holds an uncertain card PATCH for explicit retry and honors Retry-After for known failures', async () => {
    const adapter = await createAdapter();
    const created = await createApproval('request-card-update-unknown');
    const fetchMock = deliveredFetch();
    await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    const allowTicket = ticketFromMessageFetch(fetchMock, '允许');
    await feishu.handleFeishuInteractionCallback(adapter.id, {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: { value: { metapi_ticket: allowTicket } },
      },
    });
    fetchMock.mockRejectedValueOnce(new Error('socket closed after PATCH write'));
    await expect(feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any }))
      .resolves.toMatchObject({ cardUpdateUnknown: 1 });
    const afterUnknown = (await feishu.listFeishuInteractionDispatches({
      interactionId: created.request.state.requestId,
    }))[0];
    expect(afterUnknown.cardUpdate?.status).toBe('delivery_unknown');
    await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(feishu.retryFeishuCardUpdate(afterUnknown.cardUpdate!.id)).resolves.toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 999,
      msg: 'rate limited',
    }), { status: 429, headers: { 'retry-after': '30' } }));
    const beforeRetry = Date.now();
    await expect(feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any }))
      .resolves.toMatchObject({ cardUpdateFailed: 1 });
    const pending = await db.select().from(schema.interactionCardUpdates)
      .where(eq(schema.interactionCardUpdates.id, afterUnknown.cardUpdate!.id)).get();
    expect(pending?.status).toBe('pending');
    expect(Date.parse(pending!.nextAttemptAt)).toBeGreaterThanOrEqual(beforeRetry + 29_000);
  });

  it('returns an expiry warning instead of reporting a late card action as successful', async () => {
    const adapter = await createAdapter();
    const created = await createApproval('request-expired-action');
    const fetchMock = deliveredFetch();
    await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    const allowTicket = ticketFromMessageFetch(fetchMock, '允许');
    const callbackAt = created.request.state.expiresAtMs + 1_000;
    await interaction.expireInteractionRequests(callbackAt);
    const callback = await feishu.handleFeishuInteractionCallback(adapter.id, {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: { value: { metapi_ticket: allowTicket } },
      },
    }, callbackAt);

    expect(callback).toEqual({
      toast: { type: 'warning', content: '该请求已过期，请在 Metapi 控制台刷新' },
    });
    const stored = await interaction.getInteractionRequest(created.request.state.requestId);
    expect(stored?.state).toMatchObject({ status: 'expired', responsePayload: null });
    const tickets = await db.select().from(schema.interactionActionTickets).all();
    expect(tickets.every((ticket) => ticket.status === 'expired')).toBe(true);
    const events = await interaction.listInteractionEvents(created.request.state.requestId);
    expect(events.filter((event) => event.eventType === 'request_expired')).toHaveLength(1);
  });

  it('reports that another control surface already handled the request without overwriting it', async () => {
    const adapter = await createAdapter();
    const created = await createApproval('request-webui-won');
    const fetchMock = deliveredFetch();
    await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    const declineTicket = ticketFromMessageFetch(fetchMock, '拒绝');
    await interaction.commitInteractionResponse({
      requestId: created.request.state.requestId,
      responsePayload: { decision: 'accept' },
      source: 'webui',
      operatorId: 'webui:admin',
      idempotencyKey: 'webui-won',
    });

    const callback = await feishu.handleFeishuInteractionCallback(adapter.id, {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: { value: { metapi_ticket: declineTicket } },
      },
    });
    expect(callback).toEqual({
      toast: { type: 'warning', content: '该请求已由其他入口处理' },
    });
    const stored = await interaction.getInteractionRequest(created.request.state.requestId);
    expect(stored?.state.responsePayload).toEqual({ decision: 'accept' });
    const tickets = await db.select().from(schema.interactionActionTickets).all();
    expect(tickets.every((ticket) => ticket.status === 'cancelled')).toBe(true);
  });

  it('turns a Feishu form prompt into a durable Bridge steer after the interaction clears', async () => {
    const adapter = await createAdapter();
    const created = await createApproval('request-manual-prompt');
    const fetchMock = deliveredFetch();
    await feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any });
    const promptTicket = promptTicketFromMessageFetch(fetchMock, '补充当前轮');
    const callback = {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: {
          value: { metapi_ticket: promptTicket },
          form_value: { metapi_prompt: '先处理失败测试' },
        },
      },
    };
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, callback)).resolves.toEqual({
      toast: { type: 'success', content: 'Prompt 已进入 Bridge 队列' },
    });
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, callback)).resolves.toEqual({
      toast: { type: 'success', content: '该 Prompt 已处理' },
    });

    const tasks = await bridge.listBridgeContinuationTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      state: {
        taskKind: 'manual_prompt',
        status: 'waiting',
        reason: 'interaction_response_required',
        activeTurnId: 'turn-a',
      },
      requestSource: 'im',
      requestedBy: 'feishu:open_id:ou_allowed',
      sourceAdapterId: adapter.id,
    });
    const events = await bridge.listBridgeContinuationEvents(tasks[0].state.taskId);
    expect(events.map((event) => event.metadata || '').join('\n')).not.toContain('先处理失败测试');

    const ready = await bridge.recordBridgeThreadState({
      taskId: tasks[0].state.taskId,
      threadStatus: 'active',
      activeFlags: [],
      activeTurnId: 'turn-a',
    });
    expect(ready.state).toMatchObject({ status: 'backoff', pendingMethod: 'turn/steer' });
    const claim = await bridge.claimNextBridgeContinuationTask({ deviceId, ownerId: 'connector:test' });
    expect(claim?.command).toMatchObject({
      method: 'turn/steer',
      expectedTurnId: 'turn-a',
      prompt: '先处理失败测试',
    });

    const tickets = await db.select().from(schema.interactionActionTickets).all();
    expect(tickets.filter((ticket) => ticket.actionKey.startsWith('bridge_prompt:') && ticket.status === 'consumed')).toHaveLength(1);
    expect(tickets.filter((ticket) => ticket.actionKey.startsWith('bridge_prompt:') && ticket.status === 'cancelled')).toHaveLength(1);
    expect(tickets.filter((ticket) => !ticket.actionKey.startsWith('bridge_prompt:') && ticket.status === 'pending').length).toBeGreaterThan(0);
    expect(created.request.state.threadId).toBe('thread-a');
  });

  it('delivers a standalone Prompt card and consumes it into exactly one Bridge task', async () => {
    const adapter = await createAdapter();
    await threads.recordLocalConnectorThreadEvent({
      deviceId,
      event: {
        kind: 'thread_status',
        threadId: 'thread-standalone',
        title: 'Release verification',
        status: 'not_loaded',
      },
    });
    const context = await bridge.createBridgeContinuationTask({
      sessionKey: `${deviceId}:thread-standalone`,
      deviceId,
      threadId: 'thread-standalone',
      policy: { enabled: false },
    });
    const requested = await feishu.createFeishuBridgePromptCard({
      adapterId: adapter.id,
      contextTaskId: context.task.state.taskId,
      ttlMs: 60 * 60_000,
      requestedBy: 'webui:admin',
      idempotencyKey: 'prompt-card-request-1',
    });
    expect(requested).toMatchObject({
      created: true,
      card: {
        status: 'pending',
        deviceId,
        threadId: 'thread-standalone',
        contextTaskId: context.task.state.taskId,
        dispatch: { subjectKind: 'prompt_card', status: 'pending' },
      },
    });
    await expect(feishu.createFeishuBridgePromptCard({
      adapterId: adapter.id,
      contextTaskId: context.task.state.taskId,
      ttlMs: 60 * 60_000,
      requestedBy: 'webui:admin',
      idempotencyKey: 'prompt-card-request-1',
    })).resolves.toMatchObject({ created: false, card: { id: requested.card.id } });
    await expect(feishu.createFeishuBridgePromptCard({
      adapterId: adapter.id,
      contextTaskId: context.task.state.taskId,
      ttlMs: 15 * 60_000,
      requestedBy: 'webui:admin',
      idempotencyKey: 'prompt-card-request-1',
    })).rejects.toThrow('幂等键');

    const fetchMock = deliveredFetch();
    await expect(feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any }))
      .resolves.toMatchObject({ reconciled: 0, delivered: 1, unknown: 0 });
    const initialCard = cardFromFetchCall(fetchMock, 1);
    expect(initialCard.header.title.content).toBe('Release verification · 继续对话');
    expect(JSON.stringify(initialCard)).not.toContain('thread-standalone');
    expect(JSON.stringify(initialCard)).not.toContain(deviceId);
    expect(JSON.stringify(initialCard)).not.toContain(requested.card.id);
    const promptTicket = promptTicketFromMessageFetch(fetchMock, '下一轮发送');
    const callback = {
      header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_allowed' },
        action: {
          value: { metapi_ticket: promptTicket },
          form_value: { metapi_prompt: '继续修复独立卡片测试' },
        },
      },
    };
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, callback)).resolves.toEqual({
      toast: { type: 'success', content: 'Prompt 已进入 Bridge 队列' },
    });
    await expect(feishu.handleFeishuInteractionCallback(adapter.id, callback)).resolves.toEqual({
      toast: { type: 'success', content: '该 Prompt 已处理' },
    });

    const cards = await feishu.listFeishuBridgePromptCards({ adapterId: adapter.id });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: requested.card.id,
      status: 'consumed',
      consumedBy: 'feishu:open_id:ou_allowed',
      dispatch: { status: 'delivered', subjectKind: 'prompt_card' },
    });
    const tasks = await bridge.listBridgeContinuationTasks({});
    const manualTasks = tasks.filter((task) => task.state.taskKind === 'manual_prompt');
    expect(manualTasks).toHaveLength(1);
    expect(manualTasks[0]).toMatchObject({
      state: {
        threadId: 'thread-standalone',
        threadStatus: 'not_loaded',
        submissionMode: 'start_next',
        status: 'backoff',
        pendingMethod: 'turn/start',
      },
      deviceId,
      requestSource: 'im',
      requestedBy: 'feishu:open_id:ou_allowed',
      sourceAdapterId: adapter.id,
    });
    expect(cards[0].consumedTaskId).toBe(manualTasks[0].state.taskId);
    const tickets = await db.select().from(schema.interactionActionTickets).all();
    expect(tickets.filter((ticket) => ticket.promptCardId === requested.card.id && ticket.status === 'consumed')).toHaveLength(1);
    expect(tickets.filter((ticket) => ticket.promptCardId === requested.card.id && ticket.status === 'cancelled')).toHaveLength(1);
    expect(JSON.stringify(tickets)).not.toContain('继续修复独立卡片测试');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    await expect(feishu.runFeishuInteractionDispatchPass({ fetchImpl: fetchMock as any }))
      .resolves.toMatchObject({ cardUpdatesReconciled: 1, cardUpdated: 1 });
    const finalCard = cardFromFetchCall(fetchMock, 2);
    expect(finalCard.header.title.content).toBe('Release verification · 已提交');
    expect(finalCard.elements.some((element: any) => element.tag === 'action' || element.tag === 'form')).toBe(false);
    expect(JSON.stringify(finalCard)).not.toContain('继续修复独立卡片测试');
    const refreshedCards = await feishu.listFeishuBridgePromptCards({ adapterId: adapter.id });
    expect(refreshedCards[0].dispatch?.cardUpdate).toMatchObject({
      targetStatus: 'consumed',
      status: 'delivered',
    });
  });

  it('allows a standalone Prompt card while Codex Desktop owns the thread', async () => {
    const adapter = await createAdapter();
    await threads.recordLocalConnectorThreadEvent({
      deviceId,
      event: {
        kind: 'turn_started',
        threadId: 'thread-desktop-owned',
        turnId: 'turn-desktop-owned',
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
      },
    });

    await expect(feishu.createFeishuBridgePromptCard({
      adapterId: adapter.id,
      deviceId,
      threadId: 'thread-desktop-owned',
      ttlMs: 60 * 60_000,
      requestedBy: 'webui:admin',
      idempotencyKey: 'prompt-card-desktop-owned',
    })).resolves.toMatchObject({
      created: true,
      card: {
        deviceId,
        threadId: 'thread-desktop-owned',
      },
    });
  });
});
