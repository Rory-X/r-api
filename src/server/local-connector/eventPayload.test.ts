import { describe, expect, it } from 'vitest';
import { isCodexTurnCompletionHook, normalizeLocalAgentEvent } from './eventPayload.js';

describe('local connector agent event payload', () => {
  it('keeps the completion message but does not forward input prompts', () => {
    const event = normalizeLocalAgentEvent({
      kind: 'notify',
      agent: 'codex',
      threadTitle: 'Local Connector',
      rawPayload: JSON.stringify({
        type: 'agent-turn-complete',
        'thread-id': 'thread-1',
        'turn-id': 'turn-1',
        'input-messages': ['secret user prompt'],
        'last-assistant-message': 'finished safely',
      }),
    });
    expect(event.title).toBe('Local Connector · Codex 任务已完成');
    expect(event.message).toContain('会话名称：Local Connector');
    expect(event.message).toContain('助手回复：\nfinished safely');
    expect(event.message).toContain('线程 ID：thread-1');
    expect(event.message).toContain('轮次 ID：turn-1');
    expect(event.message).not.toContain('secret user prompt');
    expect(event.idempotencyKey).toBe('turn:thread-1:turn-1');
  });

  it('uses a concise fallback when notify payload has no details', () => {
    const event = normalizeLocalAgentEvent({
      kind: 'notify',
      agent: 'codex',
      rawPayload: JSON.stringify({ type: 'agent-turn-complete' }),
    });

    expect(event.title).toBe('Codex 任务已完成');
    expect(event.message).toBe('任务已完成，未提供更多详情。');
  });

  it('recognizes Codex Stop as the native end-of-turn hook', () => {
    expect(isCodexTurnCompletionHook(JSON.stringify({
      hook_event_name: 'Stop',
      'thread-id': 'thread-1',
      'turn-id': 'turn-1',
    }))).toBe(true);
    expect(isCodexTurnCompletionHook(JSON.stringify({ hook_event_name: 'SessionEnd' }))).toBe(false);
  });
});
