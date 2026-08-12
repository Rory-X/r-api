import { describe, expect, it } from 'vitest';

import { parseCodexTurnMetadata } from './codexTurnMetadata.js';

describe('parseCodexTurnMetadata', () => {
  it('reads the canonical Responses client_metadata envelope and Bridge directive', () => {
    expect(parseCodexTurnMetadata({
      body: {
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({
            session_id: 'session-1',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            request_kind: 'turn',
            metapi_bridge_task_id: 'task-1',
            metapi_bridge_route_action: 'rotate_credential',
            metapi_bridge_continuation_number: '2',
          }),
        },
      },
    })).toEqual({
      identity: {
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        requestKind: 'turn',
      },
      bridgeRouteDirective: {
        taskId: 'task-1',
        routeAction: 'rotate_credential',
        continuationNumber: 2,
      },
    });
  });

  it('falls back to the compatibility header without accepting malformed directives', () => {
    expect(parseCodexTurnMetadata({
      headers: {
        'X-Codex-Turn-Metadata': JSON.stringify({
          session_id: 'session-2',
          thread_id: 'thread-2',
          metapi_bridge_task_id: 'task-2',
          metapi_bridge_route_action: 'arbitrary_route',
          metapi_bridge_continuation_number: '1',
        }),
      },
    })).toEqual({
      identity: {
        sessionId: 'session-2',
        threadId: 'thread-2',
        turnId: null,
        requestKind: null,
      },
      bridgeRouteDirective: null,
    });
  });

  it('does not expose arbitrary metadata or accept damaged JSON', () => {
    expect(parseCodexTurnMetadata({
      body: {
        client_metadata: {
          'x-codex-turn-metadata': '{broken',
        },
      },
    })).toBeNull();
  });
});
