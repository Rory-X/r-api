export type DiscoveredModel = {
  modelName: string;
  contextLength?: number;
  contextSource?: string;
};

export type ModelDiscoveryMetadataSink = (models: DiscoveredModel[]) => void;

export type ModelContextEvidence = {
  contextLength?: unknown;
  contextSource?: string | null;
  contextUpdatedAt?: string | null;
};

const CONTEXT_FIELDS = [
  'context_length', 'contextLength', 'max_context_length', 'maxContextLength', 'context_window', 'contextWindow',
] as const;

export function normalizeContextLength(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  // Keep integer storage portable across SQLite, MySQL and PostgreSQL.
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : undefined;
}

export function readModelContextEvidence(row: ModelContextEvidence) {
  const contextLength = normalizeContextLength(row.contextLength);
  const contextSource = row.contextSource?.trim();
  const contextUpdatedAt = row.contextUpdatedAt;
  return contextLength !== undefined && contextSource && contextUpdatedAt && Number.isFinite(Date.parse(contextUpdatedAt))
    ? { contextLength, contextSource, contextUpdatedAt } : undefined;
}

/** Only explicit context limits count; input/output token limits are different capabilities. */
export function modelContextMetadata(row: unknown, source: string): Pick<DiscoveredModel, 'contextLength' | 'contextSource'> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  const record = row as Record<string, unknown>;
  const limits = CONTEXT_FIELDS.flatMap((field) => {
    const value = normalizeContextLength(record[field]);
    return value === undefined ? [] : [{ field, value }];
  });
  if (limits.length === 0) return {};
  const contextLength = Math.min(...limits.map((limit) => limit.value));
  return {
    contextLength,
    contextSource: `${source}:${limits.filter((limit) => limit.value === contextLength).map((limit) => limit.field).join(',')}`,
  };
}

export function captureModelContextMetadata(
  rows: unknown,
  source: string,
  sink?: ModelDiscoveryMetadataSink,
  normalizeName: (name: string) => string = (name) => name.trim(),
): void {
  if (!sink) return;
  const list = Array.isArray(rows) ? rows : [];
  sink(list.flatMap((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const rawName = typeof item === 'string' ? item : row.id ?? row.slug ?? row.name ?? row.model;
    const modelName = typeof rawName === 'string' ? normalizeName(rawName) : '';
    return modelName ? [{ modelName, ...modelContextMetadata(row, source) }] : [];
  }));
}

export function normalizeDiscoveredModels(rows: Array<DiscoveredModel | string>): DiscoveredModel[] {
  const models = new Map<string, DiscoveredModel>();
  for (const row of rows) {
    const value = typeof row === 'string' ? { modelName: row } : row;
    if (typeof value?.modelName !== 'string') continue;
    const modelName = value.modelName.trim();
    if (!modelName || models.has(modelName.toLowerCase())) continue;
    const contextLength = normalizeContextLength(value.contextLength);
    const contextSource = typeof value.contextSource === 'string' ? value.contextSource.trim() : '';
    models.set(modelName.toLowerCase(), {
      modelName,
      ...(contextLength !== undefined && contextSource ? { contextLength, contextSource } : {}),
    });
  }
  return [...models.values()];
}

export function modelContextColumns(model: DiscoveredModel | undefined, updatedAt: string) {
  const contextLength = normalizeContextLength(model?.contextLength);
  const contextSource = model?.contextSource?.trim();
  return contextLength !== undefined && contextSource
    ? { contextLength, contextSource, contextUpdatedAt: updatedAt }
    : { contextLength: null, contextSource: null, contextUpdatedAt: null };
}
