import { createHash } from 'node:crypto';
import type { LocalConnectorAgent, LocalConnectorEventKind } from './protocol.js';

type JsonRecord = Record<string, unknown>;

const EVENT_TITLE_LABELS: Record<string, string> = {
  'agent-turn-complete': '任务已完成',
  'agent-turn-completed': '任务已完成',
  'agent-turn-start': '任务已开始',
  'agent-turn-started': '任务已开始',
  'agent-turn-failed': '任务失败',
  'agent-turn-error': '任务异常',
  'agent-turn-interrupted': '任务已中断',
  stop: '任务已完成',
  sessionend: '会话已结束',
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstText(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const normalized = value.replace(/\0/g, '');
  const bytes = Buffer.from(normalized, 'utf8');
  if (bytes.byteLength <= maxBytes) return normalized;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8').trimEnd();
}

function parsePayload(raw: string): JsonRecord {
  const normalized = truncateUtf8(raw.trim(), 64 * 1024);
  if (!normalized) return {};
  try {
    const parsed = JSON.parse(normalized);
    return isRecord(parsed) ? parsed : { value: normalized };
  } catch {
    return { value: normalized };
  }
}

function displayTitle(agent: LocalConnectorAgent, eventName: string, threadTitle?: string | null): string {
  const agentLabel = agent === 'codex' ? 'Codex' : 'Claude Code';
  const label = EVENT_TITLE_LABELS[eventName.toLowerCase()];
  const eventTitle = label ? `${agentLabel} ${label}` : `${agentLabel}: ${truncateUtf8(eventName, 120)}`;
  const normalizedThreadTitle = typeof threadTitle === 'string'
    ? threadTitle.replace(/[\0\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return normalizedThreadTitle
    ? `${truncateUtf8(normalizedThreadTitle, 120)} · ${eventTitle}`
    : eventTitle;
}

export function localAgentEventThreadId(rawPayload: string): string | null {
  const payload = parsePayload(rawPayload);
  return firstText(payload, ['thread-id', 'thread_id', 'threadId', 'session_id', 'sessionId']);
}

export function normalizeLocalAgentEvent(input: {
  rawPayload: string;
  kind: Extract<LocalConnectorEventKind, 'hook' | 'notify'>;
  agent: LocalConnectorAgent;
  threadTitle?: string | null;
}): {
  kind: Extract<LocalConnectorEventKind, 'hook' | 'notify'>;
  title: string;
  message: string;
  level: 'info';
  idempotencyKey: string;
} {
  const payload = parsePayload(input.rawPayload);
  const eventName = firstText(payload, ['hook_event_name', 'hookEventName', 'type', 'event'])
    || (input.kind === 'notify' ? 'agent-turn-complete' : 'hook');
  const threadId = firstText(payload, ['thread-id', 'thread_id', 'threadId', 'session_id', 'sessionId']);
  const turnId = firstText(payload, ['turn-id', 'turn_id', 'turnId']);
  const cwd = firstText(payload, ['cwd', 'working_directory', 'workingDirectory']);
  const assistantMessage = firstText(payload, [
    'last-assistant-message',
    'last_assistant_message',
    'lastAssistantMessage',
  ]);
  const parts = [
    input.threadTitle ? `会话名称：${truncateUtf8(input.threadTitle, 512)}` : null,
    threadId ? `线程 ID：${truncateUtf8(threadId, 160)}` : null,
    turnId ? `轮次 ID：${truncateUtf8(turnId, 160)}` : null,
    cwd ? `工作目录：${truncateUtf8(cwd, 1_024)}` : null,
    assistantMessage ? `助手回复：\n${truncateUtf8(assistantMessage, 8 * 1024)}` : null,
  ].filter((part): part is string => Boolean(part));
  const message = parts.length > 0
    ? parts.join('\n')
    : input.kind === 'notify'
      ? '任务已完成，未提供更多详情。'
      : '已收到 Hook 事件。';
  const normalizedEventName = eventName.toLowerCase();
  const isTurnCompletion = input.kind === 'notify'
    && (normalizedEventName === 'agent-turn-complete'
      || normalizedEventName === 'agent-turn-completed'
      || normalizedEventName === 'stop');
  return {
    kind: input.kind,
    title: displayTitle(input.agent, eventName, input.threadTitle),
    message,
    level: 'info',
    idempotencyKey: isTurnCompletion && threadId && turnId
      ? `turn:${threadId}:${turnId}`
      : createHash('sha256')
        .update(`${input.agent}\0${input.kind}\0${eventName}\0${threadId || ''}\0${turnId || ''}\0${assistantMessage || ''}`)
        .digest('hex'),
  };
}

export function isCodexTurnCompletionHook(rawPayload: string): boolean {
  const payload = parsePayload(rawPayload);
  const eventName = firstText(payload, ['hook_event_name', 'hookEventName', 'type', 'event']);
  return eventName?.toLowerCase() === 'stop';
}
