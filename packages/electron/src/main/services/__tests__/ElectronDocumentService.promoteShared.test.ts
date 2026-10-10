// @vitest-environment node
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

const { dbRef, mockGlobalRegistryGet, mockFindLinkedDocumentForLocalPath } = vi.hoisted(() => ({
  dbRef: { current: null as any },
  mockGlobalRegistryGet: vi.fn(),
  mockFindLinkedDocumentForLocalPath: vi.fn(),
}));

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

vi.mock('../CollabLocalOriginService', () => ({
  findLinkedDocumentForLocalPath: mockFindLinkedDocumentForLocalPath,
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: vi.fn(() => ({})),
  isAnalyticsEnabled: () => true,
}));

vi.mock('../../../../../tracker-schema/src/TrackerDataModel', () => ({
  globalRegistry: {
    get: mockGlobalRegistryGet,
    // The policy resolver reads by explicit workspace (NIM-3702). These tests
    // are single-workspace, so both spellings answer from the same stub.
    getForWorkspace: (_workspacePath: string, type: string) => mockGlobalRegistryGet(type),
    hasWorkspaceLayer: () => true,
  },
}));

import { ElectronDocumentService, getCanonicalTrackerItemIdFromRow } from '../ElectronDocumentService';
import { applyHeadlessBodyMarkdown, readHeadlessBodyMarkdown } from '../MainBodyDocService';
import { isTrackerSyncActive, syncTrackerItem, unsyncTrackerItem } from '../TrackerSyncManager';
import { drainPendingTrackerItems } from '../tracker/trackerItemBackfill';

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
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mockGlobalRegistryGet.mockReturnValue({ sharing: 'team', draftByDefault: true });
  mockFindLinkedDocumentForLocalPath.mockResolvedValue(null);
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
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(true);
    const item = await service.setTrackerItemPublished(FM_ID, true);
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

});

/**
 * A file's `trackerId` binds it to an item this workspace already has. One
 * naming an item the room has never sent (a fixture, a copied file, a clone
 * whose rows have not synced down) used to become a native row under that id,
 * which the reconnect drain then created in the team tracker.
 */
describe('a declared trackerId binds only to an item that exists', () => {
  const DECISION_REL = 'wiki/decision/second.md';
  const DECISION_FM_ID = `fm:decision:${DECISION_REL}`;

  async function seedDecisionFile(trackerId: string): Promise<void> {
    const fullPath = path.join(tempDir, DECISION_REL);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(
      fullPath,
      `---\ntrackerStatus:\n  type: decision\ntrackerId: ${trackerId}\ntitle: Second\nstatus: accepted\n---\nx\n`,
      'utf-8',
    );
  }

  /** The real drain over the same database, for a team tracker that publishes by default. */
  function drainPort() {
    return {
      query: (sql: string, params?: unknown[]) => pglite.query<any>(sql, params),
      upsertItem: vi.fn(async () => {}),
      deleteItem: vi.fn(async () => {}),
      resolvePolicy: () => ({ known: true, policy: { sharing: 'team', draftByDefault: false } }) as const,
      countSyncedRows: async () => 0,
      emitEvent: vi.fn(),
      reloadSchemas: async () => {},
      toItem: (row: any) => (service as any).rowToTrackerItem(row),
      log: { info: vi.fn(), warn: vi.fn() },
    };
  }

  it('projects a file declaring an unknown id as a local fm: item, which the drain never pushes', async () => {
    await seedDecisionFile('dec-2');

    await (service as any).ensureFrontmatterProjectionRow(DECISION_REL, 'decision');

    const rows = (await pglite.query<any>(`SELECT * FROM tracker_items`)).rows;
    expect(rows.map((row) => [row.id, row.source, row.sync_status])).toEqual([
      [DECISION_FM_ID, 'frontmatter', 'local'],
    ]);

    const port = drainPort();
    await drainPendingTrackerItems(tempDir, port);
    expect(port.upsertItem).not.toHaveBeenCalled();
  });

  it('binds a file declaring the id of an existing item to it, without a write the drain would push', async () => {
    await pglite.query(
      `INSERT INTO tracker_items (id, type, data, workspace, source, sync_status, sync_id)
       VALUES ('dec-2', 'decision', $1, $2, 'native', 'synced', 42)`,
      [JSON.stringify({ title: 'Second', status: 'accepted' }), tempDir],
    );
    await seedDecisionFile('dec-2');

    const item = await (service as any).ensureFrontmatterProjectionRow(DECISION_REL, 'decision');

    expect(item.id).toBe('dec-2');
    const rows = (await pglite.query<any>(`SELECT * FROM tracker_items`)).rows;
    expect(rows.map((row) => [row.id, row.sync_status, row.sync_id])).toEqual([['dec-2', 'synced', 42]]);

    const port = drainPort();
    await drainPendingTrackerItems(tempDir, port);
    expect(port.upsertItem).not.toHaveBeenCalled();
  });

  it('does not bind to an item with that id in another workspace', async () => {
    await pglite.query(
      `INSERT INTO tracker_items (id, type, data, workspace, source, sync_status, sync_id)
       VALUES ('dec-2', 'decision', $1, '/elsewhere', 'native', 'synced', 42)`,
      [JSON.stringify({ title: 'Theirs' })],
    );
    await seedDecisionFile('dec-2');

    await (service as any).ensureFrontmatterProjectionRow(DECISION_REL, 'decision');

    const theirs = (await pglite.query<any>(`SELECT workspace, data FROM tracker_items WHERE id = 'dec-2'`)).rows[0];
    expect(theirs.workspace).toBe('/elsewhere');
    const data = typeof theirs.data === 'string' ? JSON.parse(theirs.data) : theirs.data;
    expect(data.title).toBe('Theirs');
    expect((await pglite.query<any>(`SELECT id FROM tracker_items WHERE workspace = $1`, [tempDir])).rows)
      .toEqual([{ id: DECISION_FM_ID }]);
  });
});

describe('setTrackerItemPublished promotes before the first room push', () => {
  it('refuses publication when the plan is already a separately shared document', async () => {
    await seedPlanFile();
    await seedFmRow();
    mockFindLinkedDocumentForLocalPath.mockResolvedValue({
      documentId: 'shared-doc-plan-copy',
      relativePath: REL,
      resolutionStatus: 'resolved',
    });

    await expect(service.setTrackerItemPublished(FM_ID, true)).rejects.toThrow(
      /already shared as a standalone document.*shared-doc-plan-copy/i,
    );

    const row = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [FM_ID])).rows[0];
    expect(row.source).toBe('frontmatter');
    expect(applyHeadlessBodyMarkdown).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(tempDir, REL), 'utf-8')).toContain(FILE_BODY);
  });

  it('moves the body into the stable tracker item and leaves only a provenance pointer on disk', async () => {
    await seedPlanFile();
    await seedFmRow();
    (applyHeadlessBodyMarkdown as any).mockResolvedValue(true);

    const item = await service.setTrackerItemPublished(FM_ID, true);

    expect(item.id).not.toContain('fm:');
    // The room write uses the NEW id exactly once -- the fm: id must never
    // reach the wire, and publication must not create a document-sharing path.
    expect(applyHeadlessBodyMarkdown).toHaveBeenCalledTimes(1);
    expect(applyHeadlessBodyMarkdown).toHaveBeenCalledWith(tempDir, item.id, FILE_BODY);

    const promoted = (await pglite.query<any>(
      `SELECT content, body_version FROM tracker_items WHERE id = $1`,
      [item.id],
    )).rows[0];
    expect(promoted.content).toBe(FILE_BODY);
    expect(Number(promoted.body_version)).toBe(1);

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(`trackerId: ${item.id}`);
    expect(written).toContain('Moved to the team tracker');
    expect(written).toContain('tracker_get');
    expect(written).not.toContain(FILE_BODY);
    // Publication lives on the item, not in a second file-level share flag.
    expect(written).not.toMatch(/^share:/m);
    // The plan extension's provenance block survives for a future unpublish.
    expect(written).toContain('planStatus:');
    expect(written).not.toContain('trackerStatus:');
  });

  it('promotes a plan published by frontmatter instead of leaving an fm: item and editable file copy', async () => {
    const fullPath = await seedPlanFile();
    await fs.writeFile(
      fullPath,
      `---\nplanStatus:\n  planId: p1\n  title: Example\n  status: draft\n  share:\n    status: team\n    body: team\n---\n${FILE_BODY}\n`,
      'utf-8',
    );
    await seedFmRow();
    (applyHeadlessBodyMarkdown as any).mockResolvedValue(true);

    await (service as any).captureFrontmatterTrackerTransition(REL, {
      planStatus: {
        planId: 'p1',
        title: 'Example',
        status: 'draft',
        share: { status: 'team', body: 'team' },
      },
    });

    const rows = (await pglite.query<any>(`SELECT * FROM tracker_items`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toContain('fm:');
    expect(rows[0].source).toBe('native');
    expect(rows[0].content).toBe(FILE_BODY);

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(`trackerId: ${rows[0].id}`);
    expect(written).toContain('Moved to the team tracker');
    expect(written).not.toContain(FILE_BODY);
    expect(written).not.toMatch(/^share:/m);
    expect(written).not.toMatch(/^\s+share:/m);
  });

  it('unsharing de-promotes: the row goes back to its fm: id and the file drops trackerId', async () => {
    await seedPlanFile();
    await seedFmRow();
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(true);
    const shared = await service.setTrackerItemPublished(FM_ID, true);

    const unshared = await service.setTrackerItemPublished(shared.id, false);

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
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(true);

    const item = await service.setTrackerItemPublished(FM_ID, false);

    expect(item.id).toBe(FM_ID);
    const row = (await pglite.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [FM_ID])).rows[0];
    expect(row.source).toBe('frontmatter');
    expect(row.source_ref).toBe(REL);
    expect(row.document_path).toBe(REL);
  });

  it('flushes the room body into the file so unsharing does not revert content', async () => {
    await seedLegacySharedRow();
    (readHeadlessBodyMarkdown as any).mockResolvedValue('## Body\n\nEdited by a teammate.');
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(true);

    await service.setTrackerItemPublished(FM_ID, false);

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain('Edited by a teammate');
    expect(written).not.toContain('Pre-share file text');
    // The frontmatter block survives the body rewrite.
    expect(written).toContain('planStatus:');
  });

  it('resharing then lands it on a stable id', async () => {
    await seedLegacySharedRow();
    vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(true);

    await service.setTrackerItemPublished(FM_ID, false);
    const reshared = await service.setTrackerItemPublished(FM_ID, true);

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
    (applyHeadlessBodyMarkdown as any).mockResolvedValue(true);
  });

  it('skips a legacy item whose source is still a standalone shared document', async () => {
    await seedPlanFile();
    await seedFmRow({ sync_status: 'synced', sync_id: 16417 });
    mockFindLinkedDocumentForLocalPath.mockResolvedValue({
      documentId: 'legacy-shared-plan-doc',
      relativePath: REL,
      resolutionStatus: 'resolved',
    });

    const report = await service.migrateSharedFrontmatterItemsToStableIds();

    expect(report.migrated).toHaveLength(0);
    expect(report.skipped).toEqual([
      expect.objectContaining({
        id: FM_ID,
        reason: expect.stringContaining('legacy-shared-plan-doc'),
      }),
    ]);
    expect(applyHeadlessBodyMarkdown).not.toHaveBeenCalled();
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

  /**
   * The body this migration moves comes from the OLD room or the local cache --
   * never from the file. Both can come back empty on a row whose file still
   * carries the plan: the sync round-trip nulls `content`, and an unreachable
   * room is now reported as unknown rather than empty. Nothing was moved, so
   * nothing may be deleted.
   */
  it('leaves the file intact when there was no body to move into the new room', async () => {
    await seedPlanFile();
    await seedFmRow({ sync_status: 'synced', sync_id: 16417, content: null });
    (readHeadlessBodyMarkdown as any).mockResolvedValue(null);

    const report = await service.migrateSharedFrontmatterItemsToStableIds();

    expect(report.migrated).toHaveLength(1);
    expect(report.migrated[0].bodySource).toBe('empty');
    expect(applyHeadlessBodyMarkdown).not.toHaveBeenCalled();

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(FILE_BODY);
    expect(written).not.toContain('Moved to the team tracker');
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
    expect(written).toContain('Moved to the team tracker');
    expect(written).not.toContain(FILE_BODY);
    expect(written).not.toMatch(/^share:/m);
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

/**
 * D7's destructive half: publication overwrites the plan's markdown body with an
 * inert provenance pointer. The body then exists in exactly one place, so the
 * write may only happen once the SERVER holds it.
 *
 * A `body_version > 0` row does not say that. It is bumped locally before the
 * room write is attempted, so a socket drop between the local Y.Doc mutation and
 * the `docUpdateAck` leaves a promoted row with `body_version = 1`, an empty
 * room, and a file that is now the only copy of the plan. The rescan and
 * frontmatter-save normalizers used to read that marker as proof and collapse
 * the file anyway -- deleting the last copy.
 */
describe('the origin file is only collapsed once the room is observed holding the body', () => {
  /**
   * Publish with the room write failing (socket dropped before the ack), which
   * leaves exactly the at-risk state: promoted row, `body_version = 1`, and a
   * file that still carries the plan.
   */
  async function publishWithoutAcknowledgment(): Promise<string> {
    await seedPlanFile();
    await seedFmRow();
    (applyHeadlessBodyMarkdown as any).mockResolvedValue(false);

    await expect(service.setTrackerItemPublished(FM_ID, true)).rejects.toThrow(
      /left intact.*retry publication/i,
    );

    const row = (await pglite.query<any>(
      `SELECT id, body_version FROM tracker_items WHERE source_ref = $1`,
      [REL],
    )).rows[0];
    expect(row.id).not.toContain('fm:');
    // The local durability marker is set: this is the state that used to be
    // mistaken for proof.
    expect(Number(row.body_version)).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(tempDir, REL), 'utf-8')).toContain(FILE_BODY);
    return row.id;
  }

  it('publication that never reaches the room leaves the body on disk', async () => {
    await publishWithoutAcknowledgment();
  });

  it('retries the same half-promoted row and finishes the acknowledged body move', async () => {
    const promotedId = await publishWithoutAcknowledgment();
    (applyHeadlessBodyMarkdown as any).mockResolvedValue(true);

    const item = await service.setTrackerItemPublished(promotedId, true);

    expect(item.id).toBe(promotedId);
    expect(applyHeadlessBodyMarkdown).toHaveBeenLastCalledWith(tempDir, promotedId, FILE_BODY);
    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(`trackerId: ${promotedId}`);
    expect(written).toContain('Moved to the team tracker');
    expect(written).not.toContain(FILE_BODY);
  });

  it('a rescan does not collapse the file while the room has no body', async () => {
    await publishWithoutAcknowledgment();
    (readHeadlessBodyMarkdown as any).mockResolvedValue(null);

    await (service as any).ensureFrontmatterProjectionRow(REL, 'plan');

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(FILE_BODY);
    expect(written).not.toContain('Moved to the team tracker');
  });

  it('a frontmatter save does not collapse the file while the room has no body', async () => {
    await publishWithoutAcknowledgment();
    (readHeadlessBodyMarkdown as any).mockResolvedValue('');

    await (service as any).captureFrontmatterTrackerTransition(REL, {
      planStatus: { planId: 'p1', title: 'Example', status: 'draft' },
    });

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).toContain(FILE_BODY);
    expect(written).not.toContain('Moved to the team tracker');
  });

  it('collapses the file once the room answers with a body', async () => {
    const itemId = await publishWithoutAcknowledgment();
    // The retry landed: the room now holds the plan.
    (readHeadlessBodyMarkdown as any).mockResolvedValue(FILE_BODY);

    await (service as any).ensureFrontmatterProjectionRow(REL, 'plan');

    const written = await fs.readFile(path.join(tempDir, REL), 'utf-8');
    expect(written).not.toContain(FILE_BODY);
    expect(written).toContain('Moved to the team tracker');
    expect(written).toContain(`trackerId: ${itemId}`);
  });
});
