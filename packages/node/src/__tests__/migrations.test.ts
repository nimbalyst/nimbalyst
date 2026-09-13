// @vitest-environment node
/**
 * The headless node derives its migration list from the schema directory's
 * filenames instead of importing `packages/electron`'s `getMigrations()` (which
 * would re-create the cross-package source edge slice 2a removed). That is only
 * safe while every entry in `getMigrations()` is a plain `sqlFile` whose name
 * matches its filename.
 *
 * Nothing about a new `run:` or inline `sql:` migration looks wrong at the
 * callsite, and the node would simply skip it -- producing a database that is
 * silently a schema version behind while both sides report success. This is the
 * assertion that turns that into a failure here.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { getMigrations } from '../../../electron/src/main/database/sqlite/MigrationRunner';
import { deriveMigrations, resolveSchemaDir } from '../db/migrations.js';

describe('derived migration list', () => {
  it('matches the Electron package\'s getMigrations() exactly', () => {
    const schemaDir = resolveSchemaDir();

    const derived = deriveMigrations(schemaDir).map((m) => ({
      version: m.version,
      name: m.name,
      file: path.basename(m.sqlFile),
    }));

    const authoritative = getMigrations(schemaDir).map((m) => {
      // A migration that is not a plain SQL file cannot be derived from a
      // filename, so record it in a shape that can never match.
      if (!m.sqlFile) {
        return { version: m.version, name: m.name, file: '<not a sqlFile migration>' };
      }
      return { version: m.version, name: m.name, file: path.basename(m.sqlFile) };
    });

    expect(derived).toEqual(authoritative);
  });

  it('resolves the schema directory the desktop app actually ships', () => {
    expect(resolveSchemaDir()).toMatch(
      /packages[/\\]electron[/\\]src[/\\]main[/\\]database[/\\]sqlite[/\\]schemas$/,
    );
  });
});
