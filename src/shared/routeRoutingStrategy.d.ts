export type RouteRoutingStrategy = 'weighted' | 'round_robin' | 'stable_first' | 'manual';

export declare const ROUTE_ROUTING_STRATEGIES: readonly RouteRoutingStrategy[];
export declare const DEFAULT_ROUTE_ROUTING_STRATEGY: RouteRoutingStrategy;

export declare function isRouteRoutingStrategy(value: unknown): value is RouteRoutingStrategy;
export declare function normalizeRouteRoutingStrategy(value: unknown): RouteRoutingStrategy;
export declare function isRoundRobinRouteRoutingStrategy(value: unknown): boolean;
