/**
 * Promotion of file-backed (frontmatter) tracker items to stable native ids at
 * share time.
 *
 * Sharing a plan/decision used to leave the item identified by the sharer's
 * local path (`fm:plan:nimbalyst-local/plans/foo.md`), so every copy-link
 * surface emitted a link nobody else could open, and the sharer kept editing
 * the markdown file while teammates edited the collab doc.
 *
 * These tests run against a REAL in-memory PGLite so the "does a rescan mint a
 * duplicate row?" question is answered by actual SQL, not by asserting on
 * mocked query strings. That duplicate is the single most likely regression of
 * the widened file->row resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PGlite } from '@electric-sql/pglite';

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as any } }));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: (sql: string, params?: unknown[]) => dbRef.current.query(sql, params),
  },
  HandledError: class HandledError extends Error {},
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));

vi.mock('../MainBodyDocService', () => ({
  applyHeadlessBodyMarkdown: vi.fn(),
  readHeadlessBodyMarkdown: vi.fn(async () => null),
}));

vi.mock('../TrackerIdentityService', () => ({
  getCurrentIdentity: () => ({ email: 'greg@stravu.com', displayName: 'Greg' }),
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: vi.fn(() => ({})),
  isAnalyticsEnabled: () => true,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: { get: vi.fn(() => ({ sync: { mode: 'hybrid', scope: 'project' } })) },
}));

import { ElectronDocumentService, getCanonicalTrackerItemIdFromRow } from '../ElectronDocumentService';
import { applyHeadlessBodyMarkdown, readHeadlessBodyMarkdown } from '../MainBodyDocService';
import { isTrackerSyncActive, syncTrackerItem, unsyncTrackerItem } from '../TrackerSyncManager';

const SCHEMA = `
  CREATE TABLE tracker_items (
    id TEXT PRIMARY KEY,
    issue_number INTEGER,
    issue_key TEXT,
    type TEXT NOT NULL,
    data JSONB NOT NULL,
    workspace TEXT NOT NULL,
    document_path TEXT,
    line_number INTEGER,
    content JSONB,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    source TEXT DEFAULT 'inline',
    source_ref TEXT,
    type_tags TEXT[] NOT NULL DEFAULT '{}',
    sync_status TEXT DEFAULT 'local',
    sync_id INTEGER,
    body_version INTEGER NOT NULL DEFAULT 0,
    deleted_at TIMESTAMPTZ,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_indexed TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE tracker_body_cache (
    item_id TEXT NOT NULL,
    body_version INTEGER NOT NULL,
    content TEXT NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_id, body_version)
  );
  CREATE TABLE tracker_personal_state (
    user_email TEXT NOT NULL,
    scope TEXT NOT NULL,
    item_id TEXT NOT NULL,
    is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
    favorite_updated_at BIGINT NOT NULL DEFAULT 0,
    last_opened_at BIGINT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_email, scope, item_id)
  );
  CREATE TABLE tracker_relationship_index (
    source_item_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    target_item_id TEXT NOT NULL
  );
`;

const REL = 'nimbalyst-local/plans/example.md';
const FM_ID = `fm:plan:${REL}`;
const FILE_BODY = '## Body\n\nOriginal file contents.';

let tempDir: string;
let service: ElectronDocumentService;
let pglite: PGlite;

async function seedPlanFile(body = FILE_BODY, extraFrontmatter = ''): Promise<string> {
  const fullPath = path.join(tempDir, REL);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(
    fullPath,
    `---\nplanStatus:\n  planId: p1\n  title: Example\n  status: draft\n${extraFrontmatter}---\n${body}\n`,
    'utf-8',
  );
  return fullPath;
}

async function seedFmRow(overrides: Record<string, unknown> = {}): Promise<void> {
  const row = {
    id: FM_ID,
    type: 'plan',
    data: JSON.stringify({ title: 'Example', status: 'draft' }),
    workspace: tempDir,
    document_path: REL,
    content: JSON.stringify(FILE_BODY),
    source: 'frontmatter',
    source_ref: REL,
    sync_status: 'local',
    sync_id: null,
    ...overrides,
  } as Record<string, unknown>;
  await pglite.query(
    `INSERT INTO tracker_items (id, type, data, workspace, document_path, line_number, content, source, source_ref, sync_status, sync_id, issue_number, issue_key)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.id, row.type, row.data, row.workspace, row.document_path, row.content,
      row.source, row.source_ref, row.sync_status, row.sync_id,
      row.issue_number ?? null, row.issue_key ?? null,
    ],
  );
}

async function countRowsForFile(): Promise<number> {
  const res = await pglite.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM tracker_items WHERE source_ref = $1`,
    [REL],
  );
  return Number(res.rows[0].count);
}

beforeEach(async () => {
  vi.clearAllMocks();
  pglite = new PGlite();
  await pglite.exec(SCHEMA);
  dbRef.current = pglite;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-shared-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service?.destroy();
  await pglite?.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('promoteFileBackedTrackerRow', () => {
  it('rewrites the row to a stable native id, keeping file provenance', async () => {
    await seedPlanFile();
    await seedFmRow();
    const row = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [FM_ID])).rows[0];

    const { newId, oldId } = await (service as any).promoteFileBackedTrackerRow(row);

    expect(oldId).toBe(FM_ID);
    expect(newId).not.toContain('fm:');
    expect(newId).toMatch(/^plan_\d+_[a-z0-9]+$/);

    const promoted = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [newId])).rows[0];
    expect(promoted).toBeTruthy();
    expect(promoted.source).toBe('native');
    // Provenance is kept so the file can still be found from the row.
    expect(promoted.source_ref).toBe(REL);
    expect(promoted.document_path).toBe(REL);
    // The old row is gone -- this is a rename, not a copy.
    expect(await countRowsForFile()).toBe(1);

    // A promoted row's public id IS its row id.
    expect(getCanonicalTrackerItemIdFromRow(promoted)).toBe(newId);
  });

  it('carries body cache and personal state to the new id', async () => {
    await seedPlanFile();
    await seedFmRow();
    await pglite.query(
      `INSERT INTO tracker_body_cache (item_id, body_version, content) VALUES ($1, 1, $2)`,
      [FM_ID, FILE_BODY],
    );
    await pglite.query(
      `INSERT INTO tracker_personal_state (user_email, scope, item_id, is_favorite, updated_at)
       VALUES ('greg@stravu.com', 'project', $1, TRUE, 1)`,
      [FM_ID],
    );
    const row = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [FM_ID])).rows[0];

    const { newId } = await (service as any).promoteFileBackedTrackerRow(row);

    const cache = await pglite.query<any>(`SELECT * FROM tracker_body_cache WHERE item_id = $1`, [newId]);
    expect(cache.rows).toHaveLength(1);
    expect(cache.rows[0].content).toBe(FILE_BODY);
    const stale = await pglite.query<any>(`SELECT * FROM tracker_body_cache WHERE item_id = $1`, [FM_ID]);
    expect(stale.rows).toHaveLength(0);

    const personal = await pglite.query<any>(`SELECT * FROM tracker_personal_state WHERE item_id = $1`, [newId]);
    expect(personal.rows).toHaveLength(1);
  });
});

describe('promoted rows survive a rescan', () => {
  async function promoteViaShare(): Promise<string> {
    await seedPlanFile();
    await seedFmRow();
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);
    const item = await service.setTrackerItemShared(FM_ID, true);
    return item.id;
  }

  it('a rescan does NOT mint a second fm: row for the same file', async () => {
    const newId = await promoteViaShare();
    expect(newId).not.toContain('fm:');

    await (service as any).ensureFrontmatterProjectionRow(REL, 'plan');

    expect(await countRowsForFile()).toBe(1);
    const only = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE source_ref = $1`, [REL])).rows[0];
    expect(only.id).toBe(newId);
  });

  it('a promoted file is inert: rescanning does not overwrite the shared body', async () => {
    const newId = await promoteViaShare();
    // Someone edits the shared item collaboratively...
    await pglite.query(`UPDATE tracker_items SET content = $1 WHERE id = $2`, [
      JSON.stringify('## Body\n\nEdited by a teammate.'),
      newId,
    ]);
    // ...while the origin file on disk drifts.
    await seedPlanFile('## Body\n\nStale local file edit.');

    await (service as any).ensureFrontmatterProjectionRow(REL, 'plan');

    const after = (await pglite.query<any>(`SELECT content FROM tracker_items WHERE id = $1`, [newId])).rows[0];
    expect(String(after.content)).toContain('Edited by a teammate');
    expect(String(after.content)).not.toContain('Stale local file edit');
  });

  it('a promoted file is inert: a frontmatter transition does not clobber item fields', async () => {
    const newId = await promoteViaShare();
    await pglite.query(`UPDATE tracker_items SET data = $1 WHERE id = $2`, [
      JSON.stringify({ title: 'Renamed by a teammate', status: 'in-review' }),
      newId,
    ]);

    await (service as any).captureFrontmatterTrackerTransition(REL, {
      planStatus: { planId: 'p1', title: 'Example', status: 'draft' },
    });

    const after = (await pglite.query<any>(`SELECT data FROM tracker_items WHERE id = $1`, [newId])).rows[0];
    const data = typeof after.data === 'string' ? JSON.parse(after.data) : after.data;
    expect(data.title).toBe('Renamed by a teammate');
    expect(data.status).toBe('in-review');
  });

  it('resolves a legacy fm: id to the promoted row', async () => {
    const newId = await promoteViaShare();
    const row = await (service as any).resolveTrackerRowForPublicId(FM_ID);
    expect(row?.id).toBe(newId);
  });

  it('stays inert after the sync round-trip nulls source_ref', async () => {
    // The room's payload carries no file path, so when the promoted item comes
    // back down the sharer's row loses `source_ref` / `document_path`. The only
    // remaining link is the file's own `trackerId` -- if the scan misses it, it
    // mints a parallel fm: row and overwrites the shared body with stale text.
    const newId = await promoteViaShare();
    await pglite.query(
      `UPDATE tracker_items SET source_ref = NULL, document_path = NULL, content = $1 WHERE id = $2`,
      [JSON.stringify('## Body\n\nEdited by a teammate.'), newId],
    );
    await seedPlanFile('## Body\n\nStale local file edit.', `trackerId: ${newId}\n`);

    await (service as any).ensureFrontmatterProjectionRow(REL, 'plan');

    const rows = (await pglite.query<any>(`SELECT * FROM tracker_items`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(newId);
    expect(String(rows[0].content)).toContain('Edited by a teammate');
  });

  it('binds a file whose frontmatter already carries trackerId to that id', async () => {
    // A teammate's clone: the file is committed with `trackerId`, the row has
    // not synced down yet. Projecting must use the declared id, not a fresh fm:.
    await seedPlanFile(FILE_BODY, 'trackerId: plan_1700000000000_abc123\n');

    await (service as any).ensureFrontmatterProjectionRow(REL, 'plan');

    const rows = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE source_ref = $1`, [REL])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('plan_1700000000000_abc123');
    expect(rows[0].source).toBe('native');
    // The binding key is not a user-visible tracker field.
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    expect(data.trackerId).toBeUndefined();
  });
});

describe('setTrackerItemShared promotes before the first room push', () => {
  it('shares under the stable id and writes trackerId + share in one file write', async () => {
    await seedPlanFile();
    await seedFmRow();
    const reconcile = vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);

    const item = await service.setTrackerItemShared(FM_ID, true);

    expect(item.id).not.toContain('fm:');
    // The room push uses the NEW id -- the fm: id must never reach the wire.
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.id }),
      item.id,
      REL,
      true,
    );

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(`trackerId: ${item.id}`);
    expect(written).toContain('status: team');
    // The plan extension's own block is still untouched.
    expect(written).toContain('planStatus:');
    expect(written).not.toContain('trackerStatus:');
  });

  it('unsharing de-promotes: the row goes back to its fm: id and the file drops trackerId', async () => {
    await seedPlanFile();
    await seedFmRow();
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);
    const shared = await service.setTrackerItemShared(FM_ID, true);

    const unshared = await service.setTrackerItemShared(shared.id, false);

    expect(unshared.id).toBe(FM_ID);
    const row = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE source_ref = $1`, [REL])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].id).toBe(FM_ID);
    expect(row[0].source).toBe('frontmatter');

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).not.toContain('trackerId:');
    expect(written).not.toContain('share:');
  });
});

describe('legacy fm: items can be unshared and reshared onto a stable id', () => {
  /**
   * What every item shared before promotion existed looks like: an `fm:` id on a
   * row the sync round-trip rewrote to `source: 'native'` with no file path.
   * Judged on `source` alone these read as native items, and the native-unshare
   * guard would refuse them -- leaving migration as the only way off the `fm:`
   * id.
   */
  async function seedLegacySharedRow(): Promise<void> {
    await seedPlanFile('## Body\n\nPre-share file text.');
    await seedFmRow({
      source: 'native',
      source_ref: null,
      document_path: null,
      sync_status: 'synced',
      sync_id: 16428,
      issue_key: 'NIM-2324',
      content: null,
    });
  }

  it('unshares instead of refusing, restoring file provenance', async () => {
    await seedLegacySharedRow();
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);

    const item = await service.setTrackerItemShared(FM_ID, false);

    expect(item.id).toBe(FM_ID);
    const row = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [FM_ID])).rows[0];
    expect(row.source).toBe('frontmatter');
    expect(row.source_ref).toBe(REL);
    expect(row.document_path).toBe(REL);
  });

  it('flushes the room body into the file so unsharing does not revert content', async () => {
    await seedLegacySharedRow();
    (readHeadlessBodyMarkdown as any).mockResolvedValue('## Body\n\nEdited by a teammate.');
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);

    await service.setTrackerItemShared(FM_ID, false);

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain('Edited by a teammate');
    expect(written).not.toContain('Pre-share file text');
    // The frontmatter block survives the body rewrite.
    expect(written).toContain('planStatus:');
  });

  it('resharing then lands it on a stable id', async () => {
    await seedLegacySharedRow();
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);

    await service.setTrackerItemShared(FM_ID, false);
    const reshared = await service.setTrackerItemShared(FM_ID, true);

    expect(reshared.id).not.toContain('fm:');
    expect(await countRowsForFile()).toBe(1);
    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(`trackerId: ${reshared.id}`);
  });
});

describe('migrateSharedFrontmatterItemsToStableIds', () => {
  const ROOM_BODY = '## Body\n\nEdited by a teammate after the share.';

  beforeEach(() => {
    (isTrackerSyncActive as any).mockReturnValue(true);
  });

  it('carries the body from the OLD room, not from the stale file', async () => {
    // The file is frozen at its pre-share text; the room has moved on.
    await seedPlanFile('## Body\n\nPre-share file text.');
    await seedFmRow({ sync_status: 'synced', sync_id: 16417, issue_number: 2324, issue_key: 'NIM-2324' });
    (readHeadlessBodyMarkdown as any).mockResolvedValue(ROOM_BODY);

    const report = await service.migrateSharedFrontmatterItemsToStableIds();

    expect(report.skipped).toHaveLength(0);
    expect(report.migrated).toHaveLength(1);
    const { oldId, newId, bodySource } = report.migrated[0];
    expect(oldId).toBe(FM_ID);
    expect(newId).not.toContain('fm:');
    expect(bodySource).toBe('room');

    // The old room was read; the new room was seeded with what it returned.
    expect(readHeadlessBodyMarkdown).toHaveBeenCalledWith(tempDir, FM_ID);
    expect(applyHeadlessBodyMarkdown).toHaveBeenCalledWith(tempDir, newId, ROOM_BODY);

    const promoted = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [newId])).rows[0];
    expect(String(promoted.content)).toContain('Edited by a teammate');
    expect(String(promoted.content)).not.toContain('Pre-share file text');
  });

  it('keeps the issue key and tombstones the old id', async () => {
    await seedPlanFile();
    await seedFmRow({ sync_status: 'synced', sync_id: 16417, issue_number: 2324, issue_key: 'NIM-2324' });
    (readHeadlessBodyMarkdown as any).mockResolvedValue(ROOM_BODY);

    const report = await service.migrateSharedFrontmatterItemsToStableIds();
    const { newId } = report.migrated[0];

    const promoted = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [newId])).rows[0];
    expect(promoted.issue_key).toBe('NIM-2324');
    expect(promoted.issue_number).toBe(2324);

    expect(syncTrackerItem).toHaveBeenCalledWith(expect.objectContaining({ id: newId, issueKey: 'NIM-2324' }));
    expect(unsyncTrackerItem).toHaveBeenCalledWith(FM_ID, tempDir);

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(`trackerId: ${newId}`);
  });

  it('picks up rows the sync round-trip already flipped to native with no file path', async () => {
    // This is what every already-shared item in a real workspace looks like:
    // an `fm:` id on a row the room rewrote to `source: 'native'`, `source_ref`
    // null. Selecting on `source = 'frontmatter'` would find none of them.
    await seedPlanFile();
    await seedFmRow({
      source: 'native',
      source_ref: null,
      document_path: null,
      sync_status: 'synced',
      sync_id: 16428,
      issue_key: 'NIM-2324',
    });
    (readHeadlessBodyMarkdown as any).mockResolvedValue(ROOM_BODY);

    const report = await service.migrateSharedFrontmatterItemsToStableIds();

    expect(report.skipped).toHaveLength(0);
    expect(report.migrated).toHaveLength(1);
    const { newId } = report.migrated[0];
    expect(newId).not.toContain('fm:');
    // The backing file was recovered from the id and stamped.
    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(`trackerId: ${newId}`);
  });

  it('leaves never-shared rows alone', async () => {
    await seedPlanFile();
    await seedFmRow(); // sync_id NULL -> never shared
    (readHeadlessBodyMarkdown as any).mockResolvedValue(ROOM_BODY);

    const report = await service.migrateSharedFrontmatterItemsToStableIds();

    expect(report.migrated).toHaveLength(0);
    expect(unsyncTrackerItem).not.toHaveBeenCalled();
    const row = (await pglite.query<any>(`SELECT id FROM tracker_items WHERE source_ref = $1`, [REL])).rows[0];
    expect(row.id).toBe(FM_ID);
  });

  it('dryRun reports candidates without touching anything', async () => {
    await seedPlanFile();
    await seedFmRow({ sync_status: 'synced', sync_id: 16417, issue_key: 'NIM-2324' });

    const report = await service.migrateSharedFrontmatterItemsToStableIds({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.migrated).toEqual([
      { oldId: FM_ID, newId: '(dry run)', issueKey: 'NIM-2324', bodySource: '(dry run)' },
    ]);
    expect(unsyncTrackerItem).not.toHaveBeenCalled();
    const row = (await pglite.query<any>(`SELECT id FROM tracker_items WHERE source_ref = $1`, [REL])).rows[0];
    expect(row.id).toBe(FM_ID);
  });
});
