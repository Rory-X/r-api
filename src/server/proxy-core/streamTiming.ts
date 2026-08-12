import type { Response } from 'undici';

import { getObservedResponseMeta } from './firstByteTimeout.js';

export type StreamTimingSnapshot = {
  routeLatencyMs: number | null;
  upstreamHeaderLatencyMs: number | null;
  upstreamFirstByteLatencyMs: number | null;
  downstreamStartAfterFirstByteMs: number | null;
};

function normalizeDuration(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

export function getStreamTimingSnapshot(input: {
  upstream: Response;
  requestReceivedAtMs: number;
  downstreamStartedAtMs?: number;
}): StreamTimingSnapshot {
  const meta = getObservedResponseMeta(input.upstream);
  const downstreamStartedAtMs = input.downstreamStartedAtMs ?? Date.now();
  if (!meta) {
    return {
      routeLatencyMs: null,
      upstreamHeaderLatencyMs: null,
      upstreamFirstByteLatencyMs: null,
      downstreamStartAfterFirstByteMs: null,
    };
  }

  return {
    routeLatencyMs: normalizeDuration(meta.dispatchStartedAtMs - input.requestReceivedAtMs),
    upstreamHeaderLatencyMs: normalizeDuration(meta.responseHeaderLatencyMs),
    upstreamFirstByteLatencyMs: normalizeDuration(meta.firstByteLatencyMs),
    downstreamStartAfterFirstByteMs: meta.firstByteAtMs === null
      ? null
      : normalizeDuration(downstreamStartedAtMs - meta.firstByteAtMs),
  };
}

export function formatStreamServerTiming(snapshot: StreamTimingSnapshot): string {
  const entries = [
    ['metapi_route', snapshot.routeLatencyMs],
    ['upstream_headers', snapshot.upstreamHeaderLatencyMs],
    ['upstream_first_byte', snapshot.upstreamFirstByteLatencyMs],
    ['metapi_stream_start', snapshot.downstreamStartAfterFirstByteMs],
  ] as const;

  return entries
    .flatMap(([name, duration]) => (
      duration === null ? [] : [`${name};dur=${duration}`]
    ))
    .join(', ');
}
