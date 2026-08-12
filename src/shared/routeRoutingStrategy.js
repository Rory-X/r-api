export const ROUTE_ROUTING_STRATEGIES = Object.freeze([
  'weighted',
  'round_robin',
  'stable_first',
  'manual',
]);

export const DEFAULT_ROUTE_ROUTING_STRATEGY = 'weighted';

export function isRouteRoutingStrategy(value) {
  return typeof value === 'string' && ROUTE_ROUTING_STRATEGIES.includes(value);
}

export function normalizeRouteRoutingStrategy(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return isRouteRoutingStrategy(normalized)
    ? normalized
    : DEFAULT_ROUTE_ROUTING_STRATEGY;
}

export function isRoundRobinRouteRoutingStrategy(value) {
  return normalizeRouteRoutingStrategy(value) === 'round_robin';
}
