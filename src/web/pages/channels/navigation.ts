export type ChannelSection = 'overview' | 'sites' | 'connections' | 'credentials' | 'recovery';

export function resolveChannelPath(_pathname: string, section: ChannelSection): string {
  return section === 'overview' ? '/channels' : `/channels/${section}`;
}

export function resolveChannelTransitionKey(pathname: string): string {
  return pathname === '/channels' || pathname.startsWith('/channels/')
    ? '/channels'
    : pathname;
}
