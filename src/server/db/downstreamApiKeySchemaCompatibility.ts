export interface DownstreamApiKeySchemaInspector {
  tableExists(table: string): boolean;
  columnExists(table: string, column: string): boolean;
  execute(sqlText: string): void;
}

export type DownstreamApiKeyColumnCompatibilitySpec = Readonly<{
  column: string;
  addSql: string;
}>;

export const DOWNSTREAM_API_KEY_COLUMN_COMPATIBILITY_SPECS: readonly DownstreamApiKeyColumnCompatibilitySpec[] = [
  { column: 'group_name', addSql: 'ALTER TABLE downstream_api_keys ADD COLUMN group_name text;' },
  { column: 'tags', addSql: 'ALTER TABLE downstream_api_keys ADD COLUMN tags text;' },
  { column: 'excluded_site_ids', addSql: 'ALTER TABLE downstream_api_keys ADD COLUMN excluded_site_ids text;' },
  { column: 'excluded_credential_refs', addSql: 'ALTER TABLE downstream_api_keys ADD COLUMN excluded_credential_refs text;' },
  { column: 'max_concurrency', addSql: 'ALTER TABLE downstream_api_keys ADD COLUMN max_concurrency integer;' },
  { column: 'policy_version', addSql: 'ALTER TABLE downstream_api_keys ADD COLUMN policy_version integer NOT NULL DEFAULT 1;' },
  { column: 'allowed_credential_refs', addSql: 'ALTER TABLE downstream_api_keys ADD COLUMN allowed_credential_refs text;' },
];

export function ensureDownstreamApiKeySchemaCompatibility(
  inspector: DownstreamApiKeySchemaInspector,
): void {
  const table = 'downstream_api_keys';
  if (!inspector.tableExists(table)) return;

  for (const spec of DOWNSTREAM_API_KEY_COLUMN_COMPATIBILITY_SPECS) {
    if (inspector.columnExists(table, spec.column)) continue;
    inspector.execute(spec.addSql);
  }
}
