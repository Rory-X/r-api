import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

describe('site concurrency migration', () => {
  it('upgrades the prior schema with unlimited defaults and deployment-wide unique slots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'r-api-site-capacity-migration-'));
    const folder = resolve('drizzle');
    const prior = join(directory, 'prior');
    mkdirSync(join(prior, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0070_premium_cerise');
    expect(index).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, index);
    writeFileSync(join(prior, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) cpSync(join(folder, `${entry.tag}.sql`), join(prior, `${entry.tag}.sql`));
    const sqlite = new Database(join(directory, 'test.db'));
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: prior });
      sqlite.prepare('INSERT INTO sites (name, url, platform) VALUES (?, ?, ?)').run('legacy', 'https://example.com', 'openai');
      migrate(db, { migrationsFolder: folder });
      const row = sqlite.prepare('SELECT id, max_concurrency, concurrency_wait_timeout_ms FROM sites').get() as { id: number; max_concurrency: null; concurrency_wait_timeout_ms: number };
      expect(row).toMatchObject({ max_concurrency: null, concurrency_wait_timeout_ms: 0 });
      sqlite.prepare('INSERT INTO site_concurrency_leases (site_id, slot, lease_token, expires_at) VALUES (?, 1, ?, ?)').run(row.id, 'owner-1', new Date(Date.now() + 1_000).toISOString());
      expect(() => sqlite.prepare('INSERT INTO site_concurrency_leases (site_id, slot, lease_token, expires_at) VALUES (?, 1, ?, ?)').run(row.id, 'owner-2', new Date().toISOString())).toThrow(/unique constraint/i);
      sqlite.prepare('UPDATE sites SET max_concurrency=2, concurrency_wait_timeout_ms=100').run();
      migrate(db, { migrationsFolder: folder });
      expect(sqlite.prepare('SELECT max_concurrency, concurrency_wait_timeout_ms FROM sites').get()).toEqual({ max_concurrency: 2, concurrency_wait_timeout_ms: 100 });
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
