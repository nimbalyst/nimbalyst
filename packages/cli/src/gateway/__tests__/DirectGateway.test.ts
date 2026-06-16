/**
 * DirectGateway unit tests against a real on-disk SQLite fixture built with the
 * actual tracker_items DDL (generated columns + JSON `data`), so list filters,
 * where-ops, status shorthand, relative-time and the JSON record shape are
 * exercised exactly as they'll behave against a live Nimbalyst DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../db/openDatabase.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectGateway } from '../DirectGateway.js';

const WORKSPACE = '/tmp/fixture-workspace';
let dbPath: string;

// Mirror of the relevant part of 0001_initial.sql (tracker_items + companions).
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
`;

function insert(db: Database.Database, row: {
  id: string; type: string; data: Record<string, unknown>;
  issueKey?: string; typeTags?: string[]; archived?: number; updated: string; created?: string;
  origin?: unknown; bodyVersion?: number;
}): void {
  const data: Record<string, unknown> = { ...row.data };
  if (row.origin) (data as any).origin = row.origin;
  db.prepare(
    `INSERT INTO tracker_items (id, issue_key, type, data, workspace, type_tags, archived, body_version, created, updated)
     VALUES (@id, @issueKey, @type, @data, @workspace, @typeTags, @archived, @bodyVersion, @created, @updated)`,
  ).run({
    id: row.id,
    issueKey: row.issueKey ?? null,
    type: row.type,
    data: JSON.stringify(data),
    workspace: WORKSPACE,
    typeTags: JSON.stringify(row.typeTags ?? [row.type]),
    archived: row.archived ?? 0,
    bodyVersion: row.bodyVersion ?? 0,
    created: row.created ?? row.updated,
    updated: row.updated,
  });
}

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-cli-')), 'nimbalyst.sqlite');
  const db = openDatabase(dbPath);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?,?,?)').run(11, 'fixture', 'now');

  const now = new Date();
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400000).toISOString();

  insert(db, { id: 'b1', issueKey: 'BUG-1', type: 'bug', updated: iso(0),
    data: { title: 'Login times out', status: 'to-do', priority: 'high', owner: 'greg', severity: 'critical', tags: ['auth', 'regression'] } });
  insert(db, { id: 'b2', issueKey: 'BUG-2', type: 'bug', updated: iso(5),
    data: { title: 'Crash on export', status: 'done', priority: 'low', owner: 'sam', severity: 'minor', tags: ['export'] } });
  insert(db, { id: 't1', issueKey: 'TASK-1', type: 'task', updated: iso(2),
    data: { title: 'Write docs', status: 'in-progress', priority: 'medium', owner: 'greg' } });
  insert(db, { id: 'b3', issueKey: 'BUG-3', type: 'bug', updated: iso(1), archived: 1,
    data: { title: 'Archived bug', status: 'to-do', priority: 'high' } });
  insert(db, { id: 'g1', issueKey: 'BUG-9', type: 'bug', updated: iso(0), bodyVersion: 1,
    data: { title: 'Imported issue', status: 'to-do' },
    origin: { external: { urn: 'github://acme/app#42' } } });
  db.prepare('INSERT INTO tracker_body_cache (item_id, body_version, content) VALUES (?,?,?)')
    .run('g1', 1, '# Repro\nSteps here');

  db.close();
});

afterAll(() => {
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('DirectGateway reads', () => {
  it('lists by type and excludes archived by default', async () => {
    const gw = new DirectGateway(dbPath);
    const items = await gw.listTrackers({ workspace: WORKSPACE, type: 'bug' });
    const keys = items.map((i) => i.issueKey).sort();
    // BUG-3 is archived -> excluded; BUG-1, BUG-2, BUG-9 remain.
    expect(keys).toEqual(['BUG-1', 'BUG-2', 'BUG-9']);
    gw.close();
  });

  it('resolves the open/closed status shorthand', async () => {
    const gw = new DirectGateway(dbPath);
    const open = await gw.listTrackers({ workspace: WORKSPACE, type: 'bug', status: 'open' });
    const closed = await gw.listTrackers({ workspace: WORKSPACE, type: 'bug', status: 'closed' });
    expect(open.map((i) => i.issueKey).sort()).toEqual(['BUG-1', 'BUG-9']);
    expect(closed.map((i) => i.issueKey)).toEqual(['BUG-2']); // status 'done' is terminal
    gw.close();
  });

  it('filters with where-ops (=, ~, in)', async () => {
    const gw = new DirectGateway(dbPath);
    const critical = await gw.listTrackers({ workspace: WORKSPACE, where: [{ field: 'severity', op: '=', value: 'critical' }] });
    expect(critical.map((i) => i.issueKey)).toEqual(['BUG-1']);

    const auth = await gw.listTrackers({ workspace: WORKSPACE, where: [{ field: 'tags', op: '~', value: 'auth' }] });
    expect(auth.map((i) => i.issueKey)).toEqual(['BUG-1']);

    const byPriority = await gw.listTrackers({ workspace: WORKSPACE, where: [{ field: 'priority', op: 'in', value: 'high,medium' }] });
    expect(byPriority.map((i) => i.issueKey).sort()).toEqual(['BUG-1', 'TASK-1']);
    gw.close();
  });

  it('applies --since relative-time on updated', async () => {
    const gw = new DirectGateway(dbPath);
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    const recent = await gw.listTrackers({ workspace: WORKSPACE, since });
    // Updated within 3 days: BUG-1 (0d), BUG-9 (0d), TASK-1 (2d). BUG-2 is 5d.
    expect(recent.map((i) => i.issueKey).sort()).toEqual(['BUG-1', 'BUG-9', 'TASK-1']);
    gw.close();
  });

  it('gets by issue key and by id with canonical record shape', async () => {
    const gw = new DirectGateway(dbPath);
    const byKey = await gw.getTracker(WORKSPACE, 'BUG-1');
    expect(byKey?.id).toBe('b1');
    expect(byKey?.primaryType).toBe('bug');
    expect(byKey?.fields.title).toBe('Login times out');
    expect(byKey?.fields.severity).toBe('critical'); // custom field preserved
    expect(byKey?.system.workspace).toBe(WORKSPACE);
    gw.close();
  });

  it('resolves by URN and reads the body cache', async () => {
    const gw = new DirectGateway(dbPath);
    const rec = await gw.getTrackerByUrn(WORKSPACE, 'github://acme/app#42');
    expect(rec?.issueKey).toBe('BUG-9');
    const body = await gw.getTrackerBody(WORKSPACE, rec!);
    expect(body).toContain('# Repro');
    gw.close();
  });

  it('lists types present with counts', async () => {
    const gw = new DirectGateway(dbPath);
    const types = await gw.listTypes(WORKSPACE);
    const bug = types.find((t) => t.type === 'bug');
    expect(bug?.count).toBe(4); // includes the archived one
    gw.close();
  });
});
