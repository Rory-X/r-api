import { lazy } from 'react';
import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ChannelManagement from './ChannelManagement.js';

describe('ChannelManagement', () => {
  it('keeps upstream workflows inside one channel surface without the global credential center', () => {
    const root = create(
      <MemoryRouter initialEntries={['/channels/sites']}>
        <Routes>
          <Route path="/channels" element={<ChannelManagement />}>
            <Route path="sites" element={<div data-testid="sites-child">sites child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(root.root.findByProps({ 'data-testid': 'channel-management' })).toBeTruthy();
    expect(root.root.findByProps({ 'data-testid': 'sites-child' }).children.join('')).toBe('sites child');

    const links = root.root.findAllByType('a');
    const activeSitesTab = links.find((link) => link.props.href === '/channels/sites');
    expect(String(activeSitesTab?.props.className || '')).toContain('active');
    expect(links.map((link) => link.props.href)).toEqual(expect.arrayContaining([
      '/channels',
      '/channels/sites',
      '/channels/connections',
      '/channels/oauth',
      '/channels/recovery',
    ]));
    expect(links.map((link) => link.props.href)).not.toContain('/channels/credentials');

    root.unmount();
  });

  it('keeps the channel shell visible while a tab bundle is loading', () => {
    const LoadingChild = lazy(() => new Promise<{ default: () => null }>(() => {}));
    const root = create(
      <MemoryRouter initialEntries={['/channels/sites']}>
        <Routes>
          <Route path="/channels" element={<ChannelManagement />}>
            <Route path="sites" element={<LoadingChild />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(root.root.findByProps({ 'data-testid': 'channel-management' })).toBeTruthy();
    expect(root.root.findByProps({ 'data-testid': 'channel-section-loading' })).toBeTruthy();
    expect(root.root.findByType('h2').children.join('')).toBe('渠道管理');
    expect(root.root.findAllByType('a')).toHaveLength(5);

    root.unmount();
  });
});
