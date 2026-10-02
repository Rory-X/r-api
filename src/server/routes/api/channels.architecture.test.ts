import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routeSource = readFileSync(new URL('./channels.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(
  new URL('../../services/channelsOverviewService.ts', import.meta.url),
  'utf8',
);

describe('channels overview architecture', () => {
  it('keeps the route as a thin adapter over the read-model service', () => {
    expect(routeSource).toContain('getChannelsOverview');
    expect(routeSource).not.toContain("../../db/index.js");
    expect(routeSource).not.toContain('schema.');
  });

  it('keeps the read model projection-only and independent from route channel truth', () => {
    expect(serviceSource).toContain('db.transaction');
    expect(serviceSource).not.toContain('.insert(');
    expect(serviceSource).not.toContain('.update(');
    expect(serviceSource).not.toContain('.delete(');
    expect(serviceSource).not.toContain('schema.routeChannels');
  });
});
