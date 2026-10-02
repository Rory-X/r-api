export type TokenRouteVisibilityItem = {
  id: number;
  modelPattern: string;
  displayName?: string | null;
  routeMode?: string | null;
  sourceRouteIds?: number[];
  enabled: boolean | null;
  kind?: string;
  readOnly?: boolean;
  isVirtual?: boolean;
};
export declare function buildVisibleTokenRoutes<T extends TokenRouteVisibilityItem>(
  routes: T[],
  isExact?: (pattern: string) => boolean,
  matches?: (model: string, pattern: string) => boolean,
): T[];
