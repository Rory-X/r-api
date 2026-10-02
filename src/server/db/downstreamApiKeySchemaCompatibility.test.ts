import { describe, expect, it } from 'vitest';
import {
  DOWNSTREAM_API_KEY_COLUMN_COMPATIBILITY_SPECS,
  ensureDownstreamApiKeySchemaCompatibility,
  type DownstreamApiKeySchemaInspector,
} from './downstreamApiKeySchemaCompatibility.js';

function createInspector(input?: {
  tableExists?: boolean;
  existingColumns?: string[];
}) {
  const executedSql: string[] = [];
  const existingColumns = new Set(input?.existingColumns || []);
  const inspector: DownstreamApiKeySchemaInspector = {
    tableExists: () => input?.tableExists ?? true,
    columnExists: (_table, column) => existingColumns.has(column),
    execute: (sqlText) => executedSql.push(sqlText),
  };
  return { inspector, executedSql };
}

describe('downstream API key schema compatibility', () => {
  it('adds every missing downstream key compatibility column', () => {
    const { inspector, executedSql } = createInspector();

    ensureDownstreamApiKeySchemaCompatibility(inspector);

    expect(executedSql).toEqual(
      DOWNSTREAM_API_KEY_COLUMN_COMPATIBILITY_SPECS.map((spec) => spec.addSql),
    );
  });

  it('repairs only allowed credential refs when the older columns already exist', () => {
    const existingColumns = DOWNSTREAM_API_KEY_COLUMN_COMPATIBILITY_SPECS
      .map((spec) => spec.column)
      .filter((column) => column !== 'allowed_credential_refs');
    const { inspector, executedSql } = createInspector({ existingColumns });

    ensureDownstreamApiKeySchemaCompatibility(inspector);

    expect(executedSql).toEqual([
      'ALTER TABLE downstream_api_keys ADD COLUMN allowed_credential_refs text;',
    ]);
  });

  it('does nothing before the downstream key table exists', () => {
    const { inspector, executedSql } = createInspector({ tableExists: false });

    ensureDownstreamApiKeySchemaCompatibility(inspector);

    expect(executedSql).toEqual([]);
  });
});
