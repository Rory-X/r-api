import { describe, expect, it } from 'vitest';
import { buildTurnCompletionNotification } from './completionNotification.js';

describe('Codex turn completion notification', () => {
  it('builds an idempotent completion message', () => {
    expect(buildTurnCompletionNotification({
      threadId: 'thread-a',
      turnId: 'turn-a',
      status: 'completed',
    })).toEqual({
      title: 'Codex 会话已完成',
      message: '线程 ID：thread-a\n轮次 ID：turn-a\n状态：completed',
      level: 'info',
      idempotencyKey: 'turn:thread-a:turn-a',
    });
  });

  it('includes the final assistant reply in the collapsible notification detail', () => {
    const notification = buildTurnCompletionNotification({
      threadId: 'thread-a',
      turnId: 'turn-a',
      status: 'completed',
      threadTitle: 'Local Connector',
      assistantMessage: '你好',
    });
    expect(notification.title).toBe('Local Connector · Codex 会话已完成');
    expect(notification.message).toBe('会话名称：Local Connector\n线程 ID：thread-a\n轮次 ID：turn-a\n状态：completed\n助手回复：\n你好');
  });

  it('marks interrupted and failed turns distinctly', () => {
    expect(buildTurnCompletionNotification({
      threadId: 'thread-a',
      turnId: 'turn-b',
      status: 'interrupted',
    }).level).toBe('warning');
    expect(buildTurnCompletionNotification({
      threadId: 'thread-a',
      turnId: 'turn-c',
      status: 'failed',
      failureMessage: 'rate limited',
    })).toMatchObject({
      title: 'Codex 会话失败',
      level: 'error',
      message: expect.stringContaining('错误：rate limited'),
    });
  });
});
