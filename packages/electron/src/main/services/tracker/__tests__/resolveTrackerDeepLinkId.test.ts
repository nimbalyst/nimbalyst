/**
 * Deep-link back-compat after a file-backed plan is promoted to a stable id.
 *
 * Links minted before the promotion (`nimbalyst://tracker/fm%3Aplan%3A…`) and
 * `tracker://fm:…` references already embedded in documents must keep opening
 * the item. So must an issue key, which is what a human actually quotes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { resolveTrackerDeepLinkId } from '../resolveTrackerDeepLinkId';

const WORKSPACE = '/tmp/workspace';
const REL = 'nimbalyst-local/plans/attachment-staging-location.md';
const PROMOTED_ID = 'plan_1753900000000_a1b2c3';

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE tracker_items (
      id TEXT PRIMARY KEY,
      issue_key TEXT,
      type TEXT NOT NULL,
      workspace TEXT NOT NULL,
      source TEXT,
      source_ref TEXT,
      updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(
    `INSERT INTO tracker_items (id, issue_key, type, workspace, source, source_ref)
     VALUES ($1, 'NIM-2324', 'plan', $2, 'native', $3)`,
    [PROMOTED_ID, WORKSPACE, REL],
  );
});

afterEach(async () => {
  await db.close();
});

describe('resolveTrackerDeepLinkId', () => {
  it('resolves a legacy fm: link to the promoted row', async () => {
    const resolved = await resolveTrackerDeepLinkId(db as any, WORKSPACE, `fm:plan:${REL}`);
    expect(resolved).toBe(PROMOTED_ID);
  });

  it('resolves an issue key to the current row id', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'NIM-2324')).toBe(PROMOTED_ID);
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'nim-2324')).toBe(PROMOTED_ID);
  });

  it('passes a live id through untouched', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, PROMOTED_ID)).toBe(PROMOTED_ID);
  });

  it('returns an unknown id unchanged so the renderer still gets its shot', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'plan_missing')).toBe('plan_missing');
    expect(await resolveTrackerDeepLinkId(db as any, WORKSPACE, 'NIM-9999')).toBe('NIM-9999');
  });

  it('does not cross workspaces', async () => {
    expect(await resolveTrackerDeepLinkId(db as any, '/tmp/other', `fm:plan:${REL}`)).toBe(`fm:plan:${REL}`);
  });
});
