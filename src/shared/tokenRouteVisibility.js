import { normalizeTokenRouteMode } from './tokenRouteContract.js';
import { isExactTokenRouteModelPattern, matchesTokenRouteModelPattern } from './tokenRoutePatterns.js';

export function buildVisibleTokenRoutes(routes, isExact = isExactTokenRouteModelPattern, matches = matchesTokenRouteModelPattern) {
    const isGroup = (route) => normalizeTokenRouteMode(route.routeMode) === 'explicit_group';
    const alias = (route) => (route.displayName || '').trim();
    const hasAlias = (route) => !!alias(route) && alias(route) !== (route.modelPattern || '').trim();
    const namedExactModels = new Set(routes
        .filter((route) => !isGroup(route) && isExact(route.modelPattern) && alias(route))
        .map((route) => route.modelPattern.trim().toLowerCase()));
    const groups = routes.filter((route) => route.enabled && (
        (isGroup(route) && alias(route) && (route.sourceRouteIds || []).length > 0)
        || (!isGroup(route) && !isExact(route.modelPattern) && hasAlias(route))
    ));
    return routes.filter((route) => {
        if (isGroup(route) || !isExact(route.modelPattern) || hasAlias(route)) return true;
        if (!route.enabled && route.kind !== 'zero_channel' && !route.readOnly && !route.isVirtual) return true;
        const model = route.modelPattern.trim();
        if (!model) return true;
        return !groups.some((group) => {
            if (group.id === route.id || namedExactModels.has(alias(group).toLowerCase())) return false;
            if (!isGroup(group) && alias(group).toLowerCase() === model.toLowerCase()) return false;
            return isGroup(group)
                ? (group.sourceRouteIds || []).includes(route.id)
                : matches(model, group.modelPattern);
        });
    });
}
