/**
 * Phase 2b: offline guarded direct writes. Exercised against an on-disk SQLite
 * fixture built with the real tracker_items DDL so create/update/comment/archive
 * shape rows exactly as the app's MCP tool handlers do, and the live-guard
 * refuses (exit 5) when a running app owns the default DB.
 *
 * These writes never touch the user's real database — each test builds its own
 * temp fixture and points DirectGateway at it via --db.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../db/openDatabase.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectGateway } from '../DirectGateway.js';

const WORKSPACE = '/tmp/fixture-write-workspace';

// Mirror of the relevant part of 0001_initial.sql (tracker_items + body cache).
const SCHEMA = `
CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);
CREATE TABLE tracker_items (
  id TEXT PRIMARY KEY,
  issue_number INTEGER,
  issue_key TEXT,
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
  bodyVersion?: number;
}): void {
  const db = openDatabase(dbPath);
  const iso = new Date().toISOString();
  db.prepare(
    `INSERT INTO tracker_items (id, issue_key, issue_number, type, data, workspace, document_path,
       type_tags, sync_status, sync_id, body_version, created, updated)
     VALUES (@id, @issueKey, @issueNumber, @type, @data, @workspace, '',
       @typeTags, @syncStatus, @syncId, @bodyVersion, @created, @updated)`,
  ).run({
    id: row.id,
    issueKey: row.issueKey ?? null,
    issueNumber: row.issueNumber ?? null,
    type: row.type,
    data: JSON.stringify(row.data),
    workspace: WORKSPACE,
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
  it('create allocates an issue key + row + body cache + activity', async () => {
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

    expect(rec.issueKey).toBe('FIX-1');
    expect(rec.primaryType).toBe('bug');
    expect(rec.fields.title).toBe('Login times out');
    expect(rec.fields.severity).toBe('critical');

    const row = rawRow(rec.id);
    expect(row.issue_key).toBe('FIX-1');
    expect(row.issue_number).toBe(1);
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
  });

  it('create increments the issue number from existing items', async () => {
    seed({ id: 'old', issueKey: 'NIM-7', issueNumber: 7, type: 'task', data: { title: 'Old', status: 'done' } });
    const gw = new DirectGateway(dbPath);
    const rec = await gw.createTracker(WORKSPACE, { type: 'bug', title: 'New' });
    gw.close();
    expect(rec.issueKey).toBe('NIM-8'); // prefix derived from NIM-7, number = max+1
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

    const row = rawRow('u1');
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
