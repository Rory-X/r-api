import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

describe('site header priority migration', () => {
  it('upgrades the previous journal without changing existing header behavior or losing settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'r-api-site-header-migration-'));
    const migrationsFolder = resolve('drizzle');
    const priorFolder = join(directory, 'prior');
    mkdirSync(join(priorFolder, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
    const migrationIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0068_gray_sabretooth');
    expect(migrationIndex).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, migrationIndex);
    writeFileSync(join(priorFolder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(priorFolder, `${entry.tag}.sql`));
    const sqlite = new Database(join(directory, 'test.db'));
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: priorFolder });
      sqlite.prepare('INSERT INTO sites (name, url, platform, custom_headers) VALUES (?, ?, ?, ?)')
        .run('legacy', 'https://example.com', 'openai', '{"Authorization":"Bearer legacy"}');
      migrate(db, { migrationsFolder });
      expect(sqlite.prepare('SELECT custom_headers, custom_headers_override_request_headers FROM sites').get()).toEqual({
        custom_headers: '{"Authorization":"Bearer legacy"}', custom_headers_override_request_headers: 0,
      });
      sqlite.prepare('UPDATE sites SET custom_headers_override_request_headers = 1').run();
      migrate(db, { migrationsFolder });
      expect(sqlite.prepare('SELECT custom_headers_override_request_headers AS enabled FROM sites').get()).toEqual({ enabled: 1 });
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
