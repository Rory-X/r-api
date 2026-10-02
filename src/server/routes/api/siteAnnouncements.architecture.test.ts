import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('announcement listing ownership', () => {
  it('delegates listing and corruption recovery to the announcement store', () => {
    const route = readFileSync(new URL('./siteAnnouncements.ts', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../../services/siteAnnouncementStore.ts', import.meta.url), 'utf8');

    expect(route).toContain('await loadSiteAnnouncements(');
    expect(route).not.toMatch(/db\.select\([^)]*\)\.from\(schema\.siteAnnouncements\)/);
    expect(route).not.toContain('loadRowsWithPostgresToastFallback');
    expect(store).not.toContain('/routes/');
    expect(store).not.toContain('fastify');
  });
});
