import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('route routing strategy architecture', () => {
  it('keeps the strategy vocabulary in the shared contract', () => {
    const serverStrategy = read('src/server/services/routeRoutingStrategy.ts');
    const webTypes = read('src/web/pages/token-routes/types.ts');
    const webStrategy = read('src/web/pages/token-routes/routingStrategy.ts');
    const duplicatedUnion = "'weighted' | 'round_robin' | 'stable_first' | 'manual'";

    expect(serverStrategy).toContain("from '../../shared/routeRoutingStrategy.js'");
    expect(webTypes).toContain("from '../../../shared/routeRoutingStrategy.js'");
    expect(webStrategy).toContain("from '../../../shared/routeRoutingStrategy.js'");
    expect(serverStrategy).not.toContain(duplicatedUnion);
    expect(webTypes).not.toContain(duplicatedUnion);
    expect(webStrategy).not.toContain(duplicatedUnion);
  });
});
