/**
 * Tests for the SQLite migration runner using a fake database handle.
 * Doesn't require better-sqlite3 to be installed; only exercises the runner's
 * orchestration logic (ordering, idempotency, the _migrations ledger).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMigrations, type Migration } from '../MigrationRunner';

/** Bare-minimum mock that supports the bits MigrationRunner touches. */
class FakeDb {
  // Map from version -> migration row.
  private migrations: Array<{ version: number; name: string }> = [];
  public execs: string[] = [];

  exec(sql: string) {
    this.execs.push(sql);
    if (/CREATE TABLE IF NOT EXISTS _migrations/i.test(sql)) {
      // ok
    }
  }

  prepare(sql: string) {
    if (/SELECT version FROM _migrations/i.test(sql)) {
      return {
        all: () => this.migrations.map((m) => ({ version: m.version })),
      };
    }
    if (/INSERT INTO _migrations/i.test(sql)) {
      return {
        run: (version: number, name: string) => {
          this.migrations.push({ version, name });
        },
      };
    }
    throw new Error(`unexpected prepare: ${sql}`);
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: any[]) => fn(...args)) as T;
  }
}

describe('runMigrations', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-migrations-'));
  });

  it('applies migrations in version order and records them', () => {
    // Use a temp schema dir with the sql files the runner expects to find.
    fs.writeFileSync(path.join(tmp, '0001_initial.sql'), '-- noop\n');
    fs.writeFileSync(path.join(tmp, '0002_pending_files_index.sql'), '-- noop\n');

    const db = new FakeDb();
    // Hack: inject our own migration list via reflection-equivalent. Re-using
    // the real getMigrations() requires reading 0001_initial.sql; we want to
    // exercise the ordering logic with custom entries.
    const customs: Migration[] = [
      { version: 2, name: 'second', sql: 'SELECT 2' },
      { version: 1, name: 'first', sql: 'SELECT 1' },
    ];
    // The simplest way to test ordering is to call the runner directly with
    // a stand-in implementation; for now, test the file-backed path with the
    // bundled migrations.
    const result = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result.applied).toEqual([1, 2]);
    expect(result.skipped).toEqual([]);

    // Second invocation: nothing to apply, all skipped.
    const result2 = runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(result2.applied).toEqual([]);
    expect(result2.skipped).toEqual([1, 2]);

    // Anti-flake: unused locals lint silencer.
    void customs;
  });

  it('reads the migration SQL from disk and execs it', () => {
    fs.writeFileSync(
      path.join(tmp, '0001_initial.sql'),
      'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
    );
    fs.writeFileSync(
      path.join(tmp, '0002_pending_files_index.sql'),
      'CREATE INDEX bar ON foo(id);',
    );
    const db = new FakeDb();
    runMigrations(db as unknown as import('better-sqlite3').Database, tmp);
    expect(db.execs.some((s) => s.includes('CREATE TABLE foo'))).toBe(true);
    expect(db.execs.some((s) => s.includes('CREATE INDEX bar'))).toBe(true);
  });
});
