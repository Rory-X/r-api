import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('route visibility contract', () => {
  it('shares the visibility and pattern vocabulary between management and dispatch', () => {
    const server = readFileSync(new URL('../server/services/tokenRouter.ts', import.meta.url), 'utf8');
    const web = readFileSync(new URL('../web/pages/helpers/routeListVisibility.ts', import.meta.url), 'utf8');
    const shared = readFileSync(new URL('./tokenRouteVisibility.js', import.meta.url), 'utf8');
    expect(server).toContain("from '../../shared/tokenRouteVisibility.js'");
    expect(web).toContain("from '../../../shared/tokenRouteVisibility.js'");
    expect(shared).toContain("from './tokenRoutePatterns.js'");
    expect(server).not.toContain('const coveringGroups =');
    expect(web).not.toContain('const coveringGroups =');
  });
});
