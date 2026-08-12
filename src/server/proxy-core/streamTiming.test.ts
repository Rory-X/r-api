import { describe, expect, it } from 'vitest';

import { fetchWithObservedFirstByte } from './firstByteTimeout.js';
import {
  formatStreamServerTiming,
  getStreamTimingSnapshot,
} from './streamTiming.js';

describe('stream timing', () => {
  it('formats routing, upstream, and downstream-start timing without request data', async () => {
    const requestReceivedAtMs = Date.now() - 5;
    const upstream = await fetchWithObservedFirstByte(
      async () => new Response('data: ready\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
      { startedAtMs: Date.now() },
    );

    const snapshot = getStreamTimingSnapshot({
      upstream,
      requestReceivedAtMs,
      downstreamStartedAtMs: Date.now(),
    });
    const header = formatStreamServerTiming(snapshot);

    expect(snapshot.routeLatencyMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.upstreamHeaderLatencyMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.upstreamFirstByteLatencyMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.downstreamStartAfterFirstByteMs).toBeGreaterThanOrEqual(0);
    expect(header).toContain('metapi_route;dur=');
    expect(header).toContain('upstream_headers;dur=');
    expect(header).toContain('upstream_first_byte;dur=');
    expect(header).toContain('metapi_stream_start;dur=');
  });
});
