import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type MigrationJournal = {
  entries: Array<{
    idx: number;
    when: number;
    tag: string;
  }>;
};

describe('SQLite migration journal', () => {
  it('registers every checked-in SQL migration exactly once and in order', () => {
    const migrationsDir = resolve(process.cwd(), 'drizzle');
    const sqlTags = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length))
      .sort();
    const journal = JSON.parse(
      readFileSync(resolve(migrationsDir, 'meta/_journal.json'), 'utf8'),
    ) as MigrationJournal;
    const journalTags = journal.entries.map((entry) => entry.tag);

    expect(new Set(journalTags).size).toBe(journalTags.length);
    expect([...journalTags].sort()).toEqual(sqlTags);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
    expect(journal.entries.map((entry) => entry.when)).toEqual(
      journal.entries.map((entry) => entry.when).sort((left, right) => left - right),
    );
  });
});
