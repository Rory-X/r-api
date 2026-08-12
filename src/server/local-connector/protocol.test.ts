import { describe, expect, it } from 'vitest';
import {
  isBridgeContinuationCommandWire,
  isLocalConnectorActionManifest,
  normalizeBridgeAppServerEventWire,
} from './protocol.js';

describe('local connector protocol', () => {
  it('accepts only the fixed declarative action manifest', () => {
    const valid = {
      protocol: 'metapi.local-connector.action.v1',
      actionId: 'action-1',
      kind: 'hook',
      operation: 'install',
      agent: 'codex',
      requiresBackup: true,
      backupRef: null,
      eventNames: ['Stop'],
      endpoints: {
        events: '/api/local-connector/public/events',
        browserRecoveryClaim: '/api/browser-credential-tasks/public/claim',
        browserRecoveryComplete: '/api/browser-credential-tasks/public/complete',
      },
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    expect(isLocalConnectorActionManifest(valid)).toBe(true);
    expect(isLocalConnectorActionManifest({ ...valid, operation: 'shell' })).toBe(false);
    expect(isLocalConnectorActionManifest({ ...valid, agent: 'arbitrary' })).toBe(false);
    expect(isLocalConnectorActionManifest({ ...valid, actionId: '../../escape' })).toBe(false);
    expect(isLocalConnectorActionManifest({
      ...valid,
      endpoints: { ...valid.endpoints, events: 'https://attacker.example/events' },
    })).toBe(false);
  });

  it('accepts fixed bridge commands and strips undeclared App Server event fields', () => {
    expect(isBridgeContinuationCommandWire({
      protocol: 'metapi.bridge-continuation.command.v1',
      taskId: 'task-1',
      leaseToken: 'bcl_abcdefghijklmnopqrstuvwxyz012345',
      leaseExpiresAt: '2026-08-04T08:00:00.000Z',
      method: 'turn/start',
      threadId: 'thread-1',
      prompt: '继续',
      routeAction: 'preserve',
      continuationNumber: 1,
    })).toBe(true);
    expect(isBridgeContinuationCommandWire({
      protocol: 'metapi.bridge-continuation.command.v1',
      taskId: 'task-1',
      leaseToken: 'bcl_abcdefghijklmnopqrstuvwxyz012345',
      leaseExpiresAt: '2026-08-04T08:00:00.000Z',
      method: 'shell',
      threadId: 'thread-1',
      prompt: '继续',
      routeAction: 'preserve',
      continuationNumber: 1,
    })).toBe(false);
    expect(isBridgeContinuationCommandWire({
      protocol: 'metapi.bridge-continuation.command.v1',
      taskId: 'manual-1',
      leaseToken: 'bcl_abcdefghijklmnopqrstuvwxyz012345',
      leaseExpiresAt: '2026-08-04T08:00:00.000Z',
      method: 'turn/steer',
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      prompt: '先处理失败测试',
      routeAction: 'preserve',
      continuationNumber: 1,
    })).toBe(true);
    expect(isBridgeContinuationCommandWire({
      protocol: 'metapi.bridge-continuation.command.v1',
      taskId: 'manual-1',
      leaseToken: 'bcl_abcdefghijklmnopqrstuvwxyz012345',
      leaseExpiresAt: '2026-08-04T08:00:00.000Z',
      method: 'turn/steer',
      threadId: 'thread-1',
      prompt: '缺少 expected turn',
      routeAction: 'preserve',
      continuationNumber: 1,
    })).toBe(false);

    const event = normalizeBridgeAppServerEventWire({
      kind: 'error',
      threadId: 'thread-1',
      turnId: 'turn-1',
      failure: {
        source: 'error_notification',
        message: 'rate limited',
        willRetry: false,
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429, secret: 'drop' } },
        diff: 'SECRET DIFF',
      },
      prompt: 'SECRET PROMPT',
    });
    expect(event).toEqual({
      kind: 'error',
      threadId: 'thread-1',
      turnId: 'turn-1',
      failure: {
        source: 'error_notification',
        message: 'rate limited',
        willRetry: false,
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      },
    });
  });
});
