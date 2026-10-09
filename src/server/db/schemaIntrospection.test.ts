import { describe, expect, it } from 'vitest';
import { isMySqlImplicitForeignKeyIndex, normalizeDefaultValue, normalizeMySqlColumnDefault, normalizeSqlType, readMySqlField } from './schemaIntrospection.js';

describe('schema introspection normalization', () => {
  it('normalizes booleans consistently across dialects', () => {
    expect(normalizeSqlType('sqlite', 'INTEGER', 'use_system_proxy')).toBe('boolean');
    expect(normalizeSqlType('mysql', 'tinyint', 'use_system_proxy')).toBe('boolean');
    expect(normalizeSqlType('postgres', 'boolean', 'use_system_proxy')).toBe('boolean');
  });

  it('normalizes common default values', () => {
    expect(normalizeDefaultValue("DEFAULT 'active'")).toBe("'active'");
    expect(normalizeDefaultValue('DEFAULT FALSE')).toBe('false');
    expect(normalizeDefaultValue("datetime('now')")).toBe("datetime('now')");
  });

  it('reads mysql information_schema fields regardless of casing', () => {
    expect(readMySqlField({ COLUMN_TYPE: 'varchar(191)' }, 'column_type')).toBe('varchar(191)');
    expect(readMySqlField({ column_type: 'text' }, 'column_type')).toBe('text');
    expect(readMySqlField({ Table_Name: 'settings' }, 'table_name')).toBe('settings');
  });

  it.each([
    ['[]', "'[]'"],
    ['https://open.feishu.cn', "'https://open.feishu.cn'"],
    ["it's enabled", "'it''s enabled'"],
    ['', "''"],
    ['true', "'true'"],
    [null, null],
  ])('preserves decoded MySQL text defaults: %j', (raw, expected) => {
    expect(normalizeMySqlColumnDefault(raw, 'text')).toBe(expected);
  });

  it('distinguishes foreign-key support indexes from declared indexes and unique constraints', () => {
    const foreignKey = { table: 'children', columns: ['parent_id'], referencedTable: 'parents', referencedColumns: ['id'], onDelete: 'CASCADE' };
    const index = { table: 'children', name: 'parent_id', columns: ['parent_id'], unique: false };
    expect(isMySqlImplicitForeignKeyIndex(index, foreignKey, 'children_parent_fk')).toBe(true);
    expect(isMySqlImplicitForeignKeyIndex({ ...index, name: 'children_parent_fk' }, foreignKey, 'children_parent_fk')).toBe(true);
    expect(isMySqlImplicitForeignKeyIndex({ ...index, name: 'children_parent_idx' }, foreignKey, 'children_parent_fk')).toBe(false);
    expect(isMySqlImplicitForeignKeyIndex({ ...index, unique: true }, foreignKey, 'children_parent_fk')).toBe(false);
    expect(isMySqlImplicitForeignKeyIndex({ ...index, columns: ['parent_id', 'status'] }, foreignKey, 'children_parent_fk')).toBe(false);
    expect(isMySqlImplicitForeignKeyIndex({ ...index, table: 'unrelated' }, foreignKey, 'children_parent_fk')).toBe(false);
  });
});
