// @vitest-environment node
/**
 * Phase 2b: offline guarded direct writes. Exercised against an on-disk SQLite
 * fixture built with the real tracker_items DDL so create/update/comment/archive
 * shape rows exactly as the app's MCP tool handlers do, and the live-guard
 * refuses (exit 5) when a running app owns the default DB.
 *
 * These writes never touch the user's real database — each test builds its own
 * temp fixture and points DirectGateway at it via --db.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase } from '../../db/openDatabase.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderList, renderRecord } from '../../cli/output.js';
import { DirectGateway } from '../DirectGateway.js';
import { getCurrentIdentity } from '../trackerWrite.js';
import { appendActivity as appendAppActivity } from '../../../../electron/src/main/services/tracker/trackerActivity';

const WORKSPACE = '/tmp/fixture-write-workspace';

// Mirror of the relevant part of 0001_initial.sql (tracker_items + body cache).
const SCHEMA = `
CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);
CREATE TABLE tracker_items (
  id TEXT PRIMARY KEY,
  issue_number INTEGER,
  issue_key TEXT,
  local_key TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  workspace TEXT NOT NULL,
  document_path TEXT,
  line_number INTEGER,
  content TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  source TEXT DEFAULT 'inline',
  source_ref TEXT,
  type_tags TEXT NOT NULL DEFAULT '[]',
  sync_status TEXT DEFAULT 'local',
  sync_id INTEGER,
  body_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  last_indexed TEXT NOT NULL DEFAULT '',
  title TEXT GENERATED ALWAYS AS (json_extract(data, '$.title')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) STORED,
  kanban_sort_order TEXT GENERATED ALWAYS AS (json_extract(data, '$.kanbanSortOrder')) STORED
);
CREATE TABLE tracker_body_cache (
  item_id TEXT NOT NULL, body_version INTEGER NOT NULL, content TEXT NOT NULL,
  cached_at TEXT, PRIMARY KEY (item_id, body_version)
);
CREATE TABLE tracker_type_defs (
  id TEXT PRIMARY KEY, workspace TEXT NOT NULL, type TEXT NOT NULL, model TEXT NOT NULL,
  source TEXT, updated TEXT NOT NULL, deleted_at TEXT, sync_id INTEGER, sync_status TEXT DEFAULT 'local'
);
`;

/** Seed a materialized custom type definition (as the app would). */
function seedTypeDef(type: string, model: Record<string, unknown>): void {
  const db = openDatabase(dbPath);
  db.prepare(
    `INSERT INTO tracker_type_defs (id, workspace, type, model, source, updated)
     VALUES (?, ?, ?, ?, 'yaml', ?)`,
  ).run(`${WORKSPACE}::${type}`, WORKSPACE, type, JSON.stringify(model), new Date().toISOString());
  db.close();
}

let dir: string;
let dbPath: string;

/** Insert a seed row directly (bypassing the gateway) for update/comment tests. */
function seed(row: {
  id: string; issueKey?: string; issueNumber?: number; type: string;
  data: Record<string, unknown>; syncStatus?: string; syncId?: number | null;
  bodyVersion?: number; localKey?: string; workspace?: string;
}): void {
  const db = openDatabase(dbPath);
  const iso = new Date().toISOString();
  db.prepare(
    `INSERT INTO tracker_items (id, issue_key, local_key, issue_number, type, data, workspace, document_path,
       type_tags, sync_status, sync_id, body_version, created, updated)
     VALUES (@id, @issueKey, @localKey, @issueNumber, @type, @data, @workspace, '',
       @typeTags, @syncStatus, @syncId, @bodyVersion, @created, @updated)`,
  ).run({
    id: row.id,
    issueKey: row.issueKey ?? null,
    localKey: row.localKey ?? null,
    issueNumber: row.issueNumber ?? null,
    type: row.type,
    data: JSON.stringify(row.data),
    workspace: row.workspace ?? WORKSPACE,
    typeTags: JSON.stringify([row.type]),
    syncStatus: row.syncStatus ?? 'local',
    syncId: row.syncId ?? null,
    bodyVersion: row.bodyVersion ?? 0,
    created: iso,
    updated: iso,
  });
  db.close();
}

/** Read raw row + body cache for assertions (separate read-only handle). */
function rawRow(id: string): any {
  const db = openDatabase(dbPath, { readonly: true });
  const row = db.prepare('SELECT * FROM tracker_items WHERE id = ?').get(id);
  db.close();
  return row;
}
function bodyCache(id: string): any[] {
  const db = openDatabase(dbPath, { readonly: true });
  const rows = db.prepare('SELECT * FROM tracker_body_cache WHERE item_id = ? ORDER BY body_version').all(id);
  db.close();
  return rows as any[];
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-cli-write-'));
  dbPath = path.join(dir, 'nimbalyst.sqlite');
  const db = openDatabase(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?,?,?)').run(11, 'fixture', 'now');
  db.close();
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('DirectGateway offline writes', () => {
  it('produces the same stored row bytes as the app update path', async () => {
    const identity = getCurrentIdentity(WORKSPACE);
    const stored = {
      title: 'Existing item',
      priority: 'medium',
      customFields: {
        activity: [{
          id: 'activity-existing',
          authorIdentity: identity,
          action: 'updated',
          field: 'priority',
          oldValue: 'low',
          newValue: 'medium',
          timestamp: 1,
        }],
      },
    };
    seed({ id: 'byte-parity', issueKey: 'NIM-1', type: 'bug', data: stored });

    const expectedAppData: Record<string, any> = structuredClone(stored);
    expectedAppData.lastModifiedBy = identity;
    expectedAppData.priority = 'high';
    vi.spyOn(Date, 'now').mockReturnValue(1_788_200_000_000);
    appendAppActivity(expectedAppData, identity, 'updated', {
      field: 'priority',
      oldValue: 'medium',
      newValue: 'high',
    });

    const gateway = new DirectGateway(dbPath);
    await gateway.updateTracker(WORKSPACE, 'NIM-1', { priority: 'high' });
    gateway.close();

    expect(rawRow('byte-parity').data).toBe(JSON.stringify(expectedAppData));
  });

  it('caps a long description edit in the activity trail exactly like the app writer', async () => {
    const identity = getCurrentIdentity(WORKSPACE);
    const before = 'a'.repeat(30_000);
    const after = 'b'.repeat(30_000);
    seed({ id: 'long-parity', issueKey: 'NIM-1', type: 'bug', data: { title: 'Plan', description: before } });

    vi.spyOn(Date, 'now').mockReturnValue(1_788_200_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const expected: Record<string, any> = {};
    appendAppActivity(expected, identity, 'updated', { field: 'description', oldValue: before, newValue: after });

    const gateway = new DirectGateway(dbPath);
    await gateway.updateTracker(WORKSPACE, 'NIM-1', { description: after });
    gateway.close();

    const stored = JSON.parse(rawRow('long-parity').data);
    expect(JSON.stringify(stored.activity)).toBe(JSON.stringify(expected.activity));
    expect(stored.activity[0].newValue.length).toBeLessThan(1_000);
  });

  it('creates a solo-workspace item without a key or number and explains the unassigned key', async () => {
    const gw = new DirectGateway(dbPath);
    const rec = await gw.createTracker(WORKSPACE, {
      type: 'bug',
      title: 'Login times out',
      status: 'to-do',
      priority: 'high',
      tags: ['auth'],
      description: 'Steps to repro',
      fields: { severity: 'critical' },
    });
    gw.close();

    expect(rec.issueKey).toBeUndefined();
    expect(rec.issueNumber).toBeUndefined();
    expect(rec.primaryType).toBe('bug');
    expect(rec.fields.title).toBe('Login times out');
    expect(rec.fields.severity).toBe('critical');

    const row = rawRow(rec.id);
    expect(row.issue_key).toBeNull();
    expect(row.issue_number).toBeNull();
    expect(row.title).toBe('Login times out'); // generated column derived from data
    expect(row.status).toBe('to-do');
    expect(row.body_version).toBe(1);
    const data = JSON.parse(row.data);
    expect(Array.isArray(data.activity)).toBe(true);
    expect(data.activity[0].action).toBe('created');
    expect(data.created).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date-only, matching the handler

    const cache = bodyCache(rec.id);
    expect(cache).toHaveLength(1);
    expect(JSON.parse(cache[0].content)).toBe('Steps to repro');

    const json = JSON.parse(renderRecord(rec, undefined, { json: true }));
    expect(json.issueKey).toBeUndefined();
    expect(json.issueKeyStatus).toBe('unassigned');
    expect(json.issueKeyMessage).toBe('This item has no key until it is published.');
    expect(renderRecord(rec, undefined, {})).toContain('This item has no key until it is published.');
    expect(renderList([rec], {})).toContain('This item has no key until it is published.');
  });

  /**
   * The CLI reads the same rows the app displays. It used to print the literal
   * word "unassigned" in the key column for items the tracker grid labelled
   * `NIM.75`, and refuse to resolve that number when handed back (#1346).
   */
  it('shows a local number as the key and resolves a dotted reference within the workspace', async () => {
    seed({ id: 'numbered', localKey: 'NIM.75', type: 'bug', data: { title: 'Numbered', status: 'to-do' } });

    const gw = new DirectGateway(dbPath);
    const rec = await gw.getTracker(WORKSPACE, 'NIM.75');
    gw.close();

    expect(rec?.id).toBe('numbered');
    expect(rec?.localKey).toBe('NIM.75');
    expect(rec?.issueKey).toBeUndefined();

    const json = JSON.parse(renderRecord(rec!, undefined, { json: true }));
    expect(json.issueKeyStatus).toBe('local');
    expect(json.localKey).toBe('NIM.75');
    expect(json.issueKeyMessage).toMatch(/private to this project/);

    // The key column, and the footnote that explains what kind of key it is.
    expect(renderList([rec!], {})).toContain('NIM.75');
    expect(renderList([rec!], {})).not.toContain('until it is published');
  });

  it('refuses to resolve a dotted number from another workspace', async () => {
    // Every project on the machine has a `.4`, and this table holds them all.
    // A cross-workspace match would confidently return the wrong item.
    seed({
      id: 'elsewhere', localKey: 'NIM.4', type: 'bug',
      workspace: '/tmp/some-other-project', data: { title: 'Other project', status: 'to-do' },
    });

    const gw = new DirectGateway(dbPath);
    const rec = await gw.getTracker(WORKSPACE, 'NIM.4');
    gw.close();

    expect(rec).toBeNull();
  });

  it('creates a room-owned workspace item without a provisional key or number', async () => {
    seed({
      id: 'shared', issueKey: 'NIM-7', issueNumber: 7, type: 'task',
      data: { title: 'Shared', status: 'done' }, syncStatus: 'synced', syncId: 7,
    });
    const gw = new DirectGateway(dbPath);
    const rec = await gw.createTracker(WORKSPACE, { type: 'bug', title: 'New' });
    gw.close();

    expect(rec.issueKey).toBeUndefined();
    expect(rec.issueNumber).toBeUndefined();
    expect(rawRow(rec.id).issue_key).toBeNull();
    expect(rawRow(rec.id).issue_number).toBeNull();
    expect(rawRow('shared').issue_key).toBe('NIM-7');
    expect(rawRow('shared').issue_number).toBe(7);
  });

  it('preserves an existing legacy LC key during update without presenting it as assigned', async () => {
    seed({ id: 'legacy', issueKey: 'LC-4', type: 'bug', data: { title: 'Legacy', status: 'to-do' } });
    const gw = new DirectGateway(dbPath);
    const updated = await gw.updateTracker(WORKSPACE, 'legacy', { priority: 'high' });
    gw.close();

    expect(updated.issueKey).toBe('LC-4');
    expect(rawRow('legacy').issue_key).toBe('LC-4');
    expect(rawRow('legacy').issue_number).toBeNull();
    expect(JSON.parse(renderRecord(updated, undefined, { json: true }))).toMatchObject({
      id: 'legacy',
      issueKeyStatus: 'unassigned',
      issueKeyMessage: 'This item has no key until it is published.',
    });
    expect(JSON.parse(renderRecord(updated, undefined, { json: true })).issueKey).toBeUndefined();
  });

  it('update merges fields, bumps updated, appends activity, and round-trips', async () => {
    seed({
      id: 'u1', issueKey: 'NIM-1', issueNumber: 1, type: 'bug',
      data: { title: 'Bug', status: 'to-do', priority: 'low' },
    });
    const before = rawRow('u1').updated;

    const gw = new DirectGateway(dbPath);
    const rec = await gw.updateTracker(WORKSPACE, 'NIM-1', {
      status: 'in-review',
      priority: 'high',
      fields: { severity: 'critical' },
    });
    gw.close();

    expect(rec.fields.status).toBe('in-review');
    expect(rec.fields.priority).toBe('high');
    expect(rec.fields.severity).toBe('critical');
    expect(rec.issueKey).toBe('NIM-1');
    expect(rec.issueNumber).toBe(1);

    const row = rawRow('u1');
    expect(row.issue_key).toBe('NIM-1');
    expect(row.issue_number).toBe(1);
    expect(row.status).toBe('in-review'); // generated column reflects the merge
    expect(row.updated).not.toBe(before); // updated stamp advanced
    const data = JSON.parse(row.data);
    const actions = data.activity.map((a: any) => a.action);
    expect(actions).toContain('status_changed');
    expect(actions).toContain('updated');
  });

  it('update --unset removes a field', async () => {
    seed({ id: 'u2', issueKey: 'NIM-2', issueNumber: 2, type: 'bug', data: { title: 'B', status: 'to-do', owner: 'greg' } });
    const gw = new DirectGateway(dbPath);
    const rec = await gw.updateTracker(WORKSPACE, 'NIM-2', { unsetFields: ['owner'] });
    gw.close();
    expect(rec.fields.owner).toBeUndefined();
    expect(JSON.parse(rawRow('u2').data).owner).toBeUndefined();
  });

  it('update bumps body_version + seeds the body cache when description changes', async () => {
    seed({ id: 'u3', issueKey: 'NIM-3', issueNumber: 3, type: 'bug', data: { title: 'B', status: 'to-do' }, bodyVersion: 2 });
    const gw = new DirectGateway(dbPath);
    await gw.updateTracker(WORKSPACE, 'NIM-3', { description: 'updated body' });
    gw.close();
    const row = rawRow('u3');
    expect(row.body_version).toBe(3);
    const cache = bodyCache('u3');
    expect(JSON.parse(cache[cache.length - 1].content)).toBe('updated body');
  });

  it('comment appends to data.comments with the canonical shape', async () => {
    seed({ id: 'c1', issueKey: 'NIM-1', issueNumber: 1, type: 'bug', data: { title: 'B', status: 'to-do' } });
    const gw = new DirectGateway(dbPath);
    await gw.commentTracker(WORKSPACE, 'NIM-1', 'Repro confirmed');
    gw.close();

    const data = JSON.parse(rawRow('c1').data);
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0]).toMatchObject({ body: 'Repro confirmed', updatedAt: null, deleted: false });
    expect(typeof data.comments[0].id).toBe('string');
    expect(typeof data.comments[0].createdAt).toBe('number');
    expect(data.activity.some((a: any) => a.action === 'commented')).toBe(true);
  });

  it('archive sets the archived column + archived_at', async () => {
    seed({ id: 'a1', issueKey: 'NIM-1', issueNumber: 1, type: 'bug', data: { title: 'B', status: 'to-do' } });
    const gw = new DirectGateway(dbPath);
    const rec = await gw.setArchived(WORKSPACE, 'NIM-1', true);
    gw.close();
    expect(rec.archived).toBe(true);
    const row = rawRow('a1');
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBeTruthy();
  });

  it('sync-eligible items become pending; local-only items stay local', async () => {
    // Already-synced item (sync_id set) -> pending on offline mutation.
    seed({ id: 's1', issueKey: 'NIM-1', issueNumber: 1, type: 'bug', data: { title: 'Synced', status: 'to-do' }, syncStatus: 'synced', syncId: 42 });
    // Purely local item -> stays local (the app drains new items by sync_id IS NULL).
    seed({ id: 's2', issueKey: 'NIM-2', issueNumber: 2, type: 'bug', data: { title: 'Local', status: 'to-do' }, syncStatus: 'local', syncId: null });

    const gw = new DirectGateway(dbPath);
    await gw.updateTracker(WORKSPACE, 'NIM-1', { status: 'in-review' });
    await gw.commentTracker(WORKSPACE, 'NIM-2', 'note');
    gw.close();

    expect(rawRow('s1').sync_status).toBe('pending');
    expect(rawRow('s2').sync_status).toBe('local');
  });

  it('resolves custom-type role fields offline from tracker_type_defs', async () => {
    // A custom type that remaps title->name and workflowStatus->state.
    seedTypeDef('crm', {
      type: 'crm',
      roles: { title: 'name', workflowStatus: 'state', assignee: 'rep' },
    });

    const gw = new DirectGateway(dbPath);
    const rec = await gw.createTracker(WORKSPACE, {
      type: 'crm',
      title: 'Acme Corp',
      status: 'lead',
      owner: 'greg',
    });
    gw.close();

    const data = JSON.parse(rawRow(rec.id).data);
    // Stored under the remapped field names, matching how the app would write it.
    expect(data.name).toBe('Acme Corp');
    expect(data.state).toBe('lead');
    expect(data.rep).toBe('greg');
    expect(data.title).toBeUndefined(); // not under the default key
  });

  it('uses the materialized schema default and required self id like the app writer', async () => {
    seedTypeDef('plan', {
      type: 'plan',
      roles: { title: 'title', workflowStatus: 'status' },
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'status', type: 'select', default: 'draft' },
        { name: 'planId', type: 'string', required: true, displayInline: false },
      ],
    });
    const gateway = new DirectGateway(dbPath);
    const record = await gateway.createTracker(WORKSPACE, { type: 'plan', title: 'Build it' });
    gateway.close();

    expect(JSON.parse(rawRow(record.id).data)).toMatchObject({
      title: 'Build it',
      status: 'draft',
      planId: record.id,
    });
  });

  it('falls back to default field names when no type def exists', async () => {
    const gw = new DirectGateway(dbPath);
    const rec = await gw.createTracker(WORKSPACE, { type: 'bug', title: 'Plain', status: 'to-do' });
    gw.close();
    const data = JSON.parse(rawRow(rec.id).data);
    expect(data.title).toBe('Plain');
    expect(data.status).toBe('to-do');
  });

  it('refuses to create or update an item straight into an approved status (exit 5)', async () => {
    seed({ id: 'r1', issueKey: 'NIM-1', issueNumber: 1, type: 'bug', data: { title: 'B', status: 'in-review' } });
    const gw = new DirectGateway(dbPath);

    // Direct status arg.
    await expect(gw.updateTracker(WORKSPACE, 'NIM-1', { status: 'approved' }))
      .rejects.toMatchObject({ code: 5 });
    // Smuggled through the generic fields bag (case-insensitive).
    await expect(gw.updateTracker(WORKSPACE, 'NIM-1', { fields: { status: 'Approved' } }))
      .rejects.toMatchObject({ code: 5 });
    // Create that starts an item already approved.
    await expect(gw.createTracker(WORKSPACE, { type: 'bug', title: 'x', status: 'approved' }))
      .rejects.toMatchObject({ code: 5 });

    // Moving into review is allowed (an agent may propose).
    const ok = await gw.updateTracker(WORKSPACE, 'NIM-1', { status: 'in-review' });
    expect(ok.fields.status).toBe('in-review');
    gw.close();
  });

  it('refuses approval through a custom workflow-status role field (exit 5)', async () => {
    seedTypeDef('review', {
      type: 'review',
      roles: { title: 'title', workflowStatus: 'phase' },
    });
    seed({ id: 'rg1', issueKey: 'NIM-1', issueNumber: 1, type: 'review', data: { title: 'R', phase: 'in-review' } });
    const gw = new DirectGateway(dbPath);
    await expect(gw.updateTracker(WORKSPACE, 'NIM-1', { fields: { phase: 'approved' } }))
      .rejects.toMatchObject({ code: 5 });
    gw.close();
  });

  it('refuses offline writes when a live app owns the default DB (exit 5)', async () => {
    // Point the userData dir at our temp dir, place the fixture where the app's
    // default sqlite path resolves, and publish a live endpoint descriptor with
    // an alive pid. A no-arg DirectGateway then targets the default DB and the
    // live-guard must refuse every write.
    const prevUserData = process.env.NIMBALYST_USER_DATA_DIR;
    const prevNimDb = process.env.NIM_DB;
    try {
      delete process.env.NIM_DB;
      process.env.NIMBALYST_USER_DATA_DIR = dir;
      const dbDir = path.join(dir, 'sqlite-db');
      fs.mkdirSync(dbDir, { recursive: true });
      const defaultDbPath = path.join(dbDir, 'nimbalyst.sqlite');
      const db = openDatabase(defaultDbPath);
      db.exec(SCHEMA);
      db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?,?,?)').run(11, 'fixture', 'now');
      db.close();
      fs.writeFileSync(
        path.join(dir, 'mcp-endpoint.json'),
        JSON.stringify({ pid: process.pid, port: 39999, token: 'x'.repeat(16) }),
      );

      const gw = new DirectGateway(); // no --db -> resolves the default path
      await expect(gw.createTracker(WORKSPACE, { type: 'bug', title: 'x' })).rejects.toMatchObject({ code: 5 });
      await expect(gw.commentTracker(WORKSPACE, 'NIM-1', 'x')).rejects.toMatchObject({ code: 5 });
      gw.close();
    } finally {
      if (prevUserData === undefined) delete process.env.NIMBALYST_USER_DATA_DIR;
      else process.env.NIMBALYST_USER_DATA_DIR = prevUserData;
      if (prevNimDb !== undefined) process.env.NIM_DB = prevNimDb;
    }
  });
});
