import { describe, expect, it } from 'vitest';
import {
  createLocalConnectorConfig,
  normalizeConnectorServerUrl,
} from './config.js';

describe('local connector config', () => {
  it('allows loopback HTTP but requires HTTPS for remote servers', () => {
    expect(normalizeConnectorServerUrl('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
    expect(normalizeConnectorServerUrl('https://gateway.example/base/')).toBe('https://gateway.example/base');
    expect(() => normalizeConnectorServerUrl('http://gateway.example')).toThrow('HTTPS');
    expect(() => normalizeConnectorServerUrl('https://user:secret@gateway.example')).toThrow('凭据');
  });

  it('preserves the local backup key and settings across forced re-pairing', () => {
    const previous = createLocalConnectorConfig({
      serverUrl: 'https://old.example',
      deviceId: 'old-device',
      connectorToken: 'old-token',
      configPath: '/tmp/metapi-old/config.json',
      pollIntervalMs: 7_000,
      appServerEndpoint: 'unix:/tmp/codex.sock',
    });
    const next = createLocalConnectorConfig({
      serverUrl: 'https://new.example',
      deviceId: 'new-device',
      connectorToken: 'new-token',
      configPath: '/tmp/metapi-new/config.json',
      previousConfig: previous,
    });
    expect(Buffer.from(previous.backupKey, 'base64url')).toHaveLength(32);
    expect(next.backupKey).toBe(previous.backupKey);
    expect(next.dataDir).toBe(previous.dataDir);
    expect(next.pollIntervalMs).toBe(7_000);
    expect(next.appServerEndpoint).toBe('unix:/tmp/codex.sock');
  });
});
