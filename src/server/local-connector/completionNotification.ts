export type TurnCompletionNotificationInput = {
  threadId: string;
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  threadTitle?: string | null;
  assistantMessage?: string | null;
  failureMessage?: string | null;
};

export type TurnCompletionNotification = {
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  idempotencyKey: string;
};

function truncateUtf8(value: string, maxBytes: number): string {
  const normalized = value.replace(/\0/g, '');
  const bytes = Buffer.from(normalized, 'utf8');
  if (bytes.byteLength <= maxBytes) return normalized;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8').trimEnd();
}

export function buildTurnCompletionNotification(
  input: TurnCompletionNotificationInput,
): TurnCompletionNotification {
  const statusLabel = input.status === 'completed'
    ? '已完成'
    : input.status === 'interrupted'
      ? '已中断'
      : '失败';
  const level = input.status === 'failed'
    ? 'error'
    : input.status === 'interrupted'
      ? 'warning'
      : 'info';
  const failure = typeof input.failureMessage === 'string' && input.failureMessage.trim()
    ? `\n错误：${input.failureMessage.trim().replace(/[\r\n]+/g, ' ').slice(0, 1_000)}`
    : '';
  const assistantMessage = typeof input.assistantMessage === 'string' && input.assistantMessage.trim()
    ? `\n助手回复：\n${input.assistantMessage.trim().replace(/\0/g, '').slice(0, 8_000)}`
    : '';
  const threadTitle = typeof input.threadTitle === 'string'
    ? input.threadTitle.replace(/[\0\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  const baseTitle = `Codex 会话${statusLabel}`;
  return {
    title: threadTitle ? `${truncateUtf8(threadTitle, 104)} · ${baseTitle}` : baseTitle,
    message: `${threadTitle ? `会话名称：${threadTitle}\n` : ''}线程 ID：${input.threadId}\n轮次 ID：${input.turnId}\n状态：${input.status}${assistantMessage}${failure}`,
    level,
    // The same key is used by the native notify path so both transports are
    // safe to enable at the same time.
    idempotencyKey: `turn:${input.threadId}:${input.turnId}`,
  };
}
