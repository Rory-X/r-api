import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Settings mobile layout', () => {
  it('collapses fixed form grids behind the shared mobile breakpoint', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8');

    expect(source).toContain("import { useIsMobile } from '../components/useIsMobile.js'");
    expect(source).toContain('const isMobile = useIsMobile()');
    expect(source).toContain("gridTemplateColumns: isMobile ? '1fr' : '180px 180px auto'");
    expect(source).toContain("gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr'");
    expect(source).toContain("gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr'");
  });

  it('uses a sticky horizontal category switcher with scroll and keyboard navigation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8');
    const styles = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    const mobileSettingsStyles = styles.slice(styles.indexOf('@media (max-width: 760px)'));

    expect(source).toContain("aria-orientation={isMobile ? 'horizontal' : 'vertical'}");
    expect(source).toContain('selectSettingsSection(section.key, event.currentTarget)');
    expect(source).toContain("trigger?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' })");
    expect(source).toContain("event.key === 'Home'");
    expect(source).toContain("event.key === 'ArrowRight'");
    expect(source).toContain('从上方快速切换分类');
    expect(mobileSettingsStyles).toMatch(/\.settings-main-nav\s*\{[^}]*position:\s*sticky;/s);
    expect(mobileSettingsStyles).toMatch(/\.settings-main-nav\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(mobileSettingsStyles).toContain('scroll-snap-type: x proximity');
  });
});
