import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Dashboard mobile layout', () => {
  it('uses the shared mobile breakpoint to collapse fixed desktop grids', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Dashboard.tsx'), 'utf8');

    expect(source).toContain('import { useIsMobile } from "../components/useIsMobile.js";');
    expect(source).toContain('const isMobile = useIsMobile()');
    expect(source).toContain('gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr"');
    expect(source).toContain('gridTemplateColumns: isMobile ? "1fr" : "1fr 300px"');
  });

  it('prioritizes mobile health, shortcuts, compact metrics, and opt-in analytics', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Dashboard.tsx'), 'utf8');

    expect(source).toContain('className="dashboard-mobile-health"');
    expect(source).toContain('className="dashboard-mobile-shortcuts"');
    expect(source).toContain('className="dashboard-mobile-metric-grid"');
    expect(source).toContain('const [mobileAnalyticsOpen, setMobileAnalyticsOpen] = useState(false)');
    expect(source).toContain('const [mobileModelAnalysisOpen, setMobileModelAnalysisOpen] = useState(false)');
    expect(source).toContain('const [mobileSiteInfoOpen, setMobileSiteInfoOpen] = useState(false)');
    expect(source).toContain('className="dashboard-mobile-chart-switch"');
    expect(source).toContain('className="dashboard-mobile-section-toggle"');
    expect(source).toContain('id="dashboard-model-analysis-content"');
    expect(source).toContain('id="dashboard-site-info-content"');
    expect(source).toContain('{mobileAnalyticsOpen ? "收起趋势" : "展开趋势"}');
    expect(source).toContain('dashboard-mobile-overview-loading');
  });
});
