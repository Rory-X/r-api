import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

describe('model context metadata migration', () => {
  it('upgrades legacy model rows with unknown metadata and preserves evidence on repeated migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'r-api-model-context-migration-'));
    const migrationsFolder = resolve('drizzle');
    const priorFolder = join(directory, 'prior');
    mkdirSync(join(priorFolder, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
    const migrationIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0069_glorious_golden_guardian');
    expect(migrationIndex).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, migrationIndex);
    writeFileSync(join(priorFolder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(priorFolder, `${entry.tag}.sql`));
    const sqlite = new Database(join(directory, 'test.db'));
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: priorFolder });
      sqlite.prepare('INSERT INTO sites (name, url, platform) VALUES (?, ?, ?)').run('legacy', 'https://example.com', 'openai');
      sqlite.prepare("INSERT INTO accounts (site_id, username, access_token) VALUES (1, 'legacy', 'session')").run();
      sqlite.prepare("INSERT INTO account_tokens (account_id, name, token) VALUES (1, 'key', 'token')").run();
      sqlite.prepare("INSERT INTO model_availability (account_id, model_name, available) VALUES (1, 'known', 1)").run();
      sqlite.prepare("INSERT INTO token_model_availability (token_id, model_name, available) VALUES (1, 'known', 1)").run();
      migrate(db, { migrationsFolder });
      for (const table of ['model_availability', 'token_model_availability']) {
        expect(sqlite.prepare(`SELECT context_length, context_source, context_updated_at FROM ${table}`).get()).toEqual({
          context_length: null, context_source: null, context_updated_at: null,
        });
        sqlite.prepare(`UPDATE ${table} SET context_length = 128000, context_source = 'test.models:context_length', context_updated_at = '2026-10-04T00:00:00Z'`).run();
      }
      migrate(db, { migrationsFolder });
      for (const table of ['model_availability', 'token_model_availability']) {
        expect(sqlite.prepare(`SELECT model_name, available, context_length FROM ${table}`).get()).toEqual({ model_name: 'known', available: 1, context_length: 128000 });
      }
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
