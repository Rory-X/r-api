export type FirstByteRoutingPolicy = {
  enabled: boolean;
  baselineMs: number;
  penaltyWindowMs: number;
  maxPenaltyRatio: number;
  minSamples: number;
};

export declare const DEFAULT_FIRST_BYTE_ROUTING_POLICY: Readonly<FirstByteRoutingPolicy>;

export declare function normalizeFirstByteRoutingPolicy(value: unknown): FirstByteRoutingPolicy;

export declare function resolveFirstByteRoutingMultiplier(input: {
  latencyEmaMs?: number | null;
  sampleCount?: number | null;
  policy?: FirstByteRoutingPolicy | null;
}): number;
