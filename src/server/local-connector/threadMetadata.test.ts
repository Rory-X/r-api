import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readLocalConnectorThreadTitle,
  rememberLocalConnectorThreadMetadata,
} from './threadMetadata.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local connector thread metadata', () => {
  it('persists normalized thread titles for native notify subprocesses', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'metapi-thread-metadata-'));
    roots.push(dataDir);

    await rememberLocalConnectorThreadMetadata({
      dataDir,
      now: Date.parse('2026-08-12T03:20:00.000Z'),
      threads: [{
        threadId: 'thread-title',
        title: '  Local\nConnector  ',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    await expect(readLocalConnectorThreadTitle(dataDir, 'thread-title'))
      .resolves.toBe('Local Connector');
    await expect(readLocalConnectorThreadTitle(dataDir, 'missing-thread'))
      .resolves.toBeNull();
  });
});
