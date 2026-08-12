import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import SiteTrendChart from './SiteTrendChart.js';

vi.mock('@visactor/react-vchart', () => ({
  VChart: () => null,
}));

describe('SiteTrendChart', () => {
  it.each([
    { state: 'loading', loading: true, data: [] },
    { state: 'empty', loading: false, data: [] },
    {
      state: 'ready',
      loading: false,
      data: [{ date: '2026-08-07', sites: { Demo: { spend: 1, calls: 2 } } }],
    },
  ])('fills the dashboard grid cell in the $state state', ({ state, loading, data }) => {
    const root = create(<SiteTrendChart data={data} loading={loading} />);

    try {
      const shell = root.root.findByProps({
        'data-testid': 'site-trend-chart',
        'data-state': state,
      });
      expect(shell.props.style).toEqual(expect.objectContaining({
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
      }));

      if (state === 'empty') {
        const emptyState = root.root.find((node) => (
          node.props.className === 'empty-state'
        ));
        expect(emptyState.props.style).toEqual(expect.objectContaining({
          flex: 1,
          justifyContent: 'center',
        }));
      }
    } finally {
      root.unmount();
    }
  });
});
