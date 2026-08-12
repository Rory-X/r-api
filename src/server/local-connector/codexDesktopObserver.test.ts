import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexDesktopSessionObserver } from './codexDesktopObserver.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function event(type: 'task_started' | 'task_complete', turnId: string, timestamp: string): string {
  return `${JSON.stringify({ timestamp, type: 'event_msg', payload: { type, turn_id: turnId } })}\n`;
}

describe('Codex Desktop session observer', () => {
  it('derives loaded and active sessions from writer locks and lifecycle metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'metapi-codex-home-'));
    roots.push(codexHome);
    const locks = join(codexHome, 'thread-writer-locks');
    const sessions = join(codexHome, 'sessions', '2026', '08', '11');
    await mkdir(locks, { recursive: true });
    await mkdir(sessions, { recursive: true });

    const activeThreadId = '019fd662-2075-79f2-9c34-1c5f4657881d';
    const idleThreadId = '019feec2-8357-7a03-b8ba-8f1f4623a8ef';
    const loadedThreadId = '019feee0-8c12-7b72-a9c4-214f31f97d64';
    const activeTurnId = '019feee3-c261-7251-8f49-8196f314f5a3';
    const idleTurnId = '019feed6-fb28-7573-891e-c17f571d33ff';
    for (const threadId of [activeThreadId, idleThreadId, loadedThreadId]) {
      await writeFile(join(locks, `${threadId}.lock`), '');
    }
    const activePath = join(sessions, `rollout-2026-08-11T09-00-00-${activeThreadId}.jsonl`);
    await writeFile(activePath, [
      JSON.stringify({ timestamp: '2026-08-11T01:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'private' } }),
      event('task_started', activeTurnId, '2026-08-11T01:00:01.000Z').trimEnd(),
    ].join('\n') + '\n');
    await writeFile(join(sessions, `rollout-2026-08-11T08-00-00-${idleThreadId}.jsonl`),
      event('task_complete', idleTurnId, '2026-08-11T00:10:00.000Z'));

    const observer = new CodexDesktopSessionObserver({ codexHome });
    const first = await observer.scan();
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: activeThreadId,
        status: 'active',
        activeTurnId,
        lastTurnId: activeTurnId,
        lastTurnStatus: null,
      }),
      expect.objectContaining({
        threadId: idleThreadId,
        status: 'loaded',
        activeTurnId: null,
        lastTurnId: idleTurnId,
        lastTurnStatus: 'completed',
      }),
      expect.objectContaining({ threadId: loadedThreadId, status: 'loaded', activeTurnId: null }),
    ]));

    await appendFile(activePath, event('task_complete', activeTurnId, '2026-08-11T01:05:00.000Z'));
    const second = await observer.scan();
    expect(second.find((item) => item.threadId === activeThreadId)).toMatchObject({
      status: 'loaded',
      activeTurnId: null,
      lastTurnId: activeTurnId,
      lastTurnStatus: 'completed',
      lastTurnAt: '2026-08-11T01:05:00.000Z',
    });
  });

  it('ignores lifecycle-looking text outside structured event metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'metapi-codex-home-'));
    roots.push(codexHome);
    const threadId = '019fd662-2075-79f2-9c34-1c5f4657881d';
    const locks = join(codexHome, 'thread-writer-locks');
    const sessions = join(codexHome, 'sessions', '2026', '08', '11');
    await mkdir(locks, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(locks, `${threadId}.lock`), '');
    await writeFile(join(sessions, `rollout-2026-08-11T09-00-00-${threadId}.jsonl`), `${JSON.stringify({
      timestamp: '2026-08-11T01:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', text: '\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"' },
    })}\n`);

    const sessionsSnapshot = await new CodexDesktopSessionObserver({ codexHome }).scan();
    expect(sessionsSnapshot[0]).toMatchObject({ status: 'loaded', activeTurnId: null });
  });
});
