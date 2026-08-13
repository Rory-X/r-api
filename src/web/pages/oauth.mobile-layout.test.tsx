import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('OAuthManagement responsive card layout', () => {
  it('uses the same Cockpit-style credential cards on desktop and mobile', () => {
    const pageSource = readFileSync(resolve(process.cwd(), 'src/web/pages/OAuthManagement.tsx'), 'utf8');
    const cssSource = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');

    expect(pageSource).toContain('className="mobile-filter-row oauth-mobile-trigger-row"');
    expect(pageSource).toContain('className="official-credential-grid"');
    expect(pageSource).toContain('className={`official-credential-card is-${schedulingState}');
    expect(pageSource).not.toContain('<MobileCard');
    expect(cssSource).toContain('.official-credential-grid');
    expect(cssSource).toContain('.official-credential-card.is-cooldown');
    expect(cssSource).toContain('.official-credential-card.is-blocked');
    expect(cssSource).toContain('.official-credential-grid,\n  .official-access-options {\n    grid-template-columns: minmax(0, 1fr);');
    expect(cssSource).toContain('.oauth-mobile-trigger-row');
  });
});
