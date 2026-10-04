import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
describe('site capacity architecture', () => {
  it('shares database slot and heartbeat ownership with downstream concurrency', () => {
    for (const file of ['./siteConcurrencyService.ts', './downstreamApiKeyService.ts']) {
      const text = source(file);
      expect(text).toContain('extends DatabaseSlotLease');
      expect(text).toContain('claimDatabaseLeaseSlot(');
      expect(text).not.toContain('setInterval(');
    }
    expect(source('./siteConcurrencyService.ts')).not.toMatch(/from ['"][^'"]*(?:routes|fastify)/);
    expect(source('./databaseSlotLease.ts')).not.toMatch(/new Map/);
  });
});
