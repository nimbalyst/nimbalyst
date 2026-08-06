// @vitest-environment node
/**
 * The pending pre-edit tag is the baseline every red/green AI diff renders
 * against. These tests pin the one rule that makes a multi-edit turn render as
 * ONE cumulative diff: once an authoritative writer has recorded a baseline for
 * a (file, session), later authoritative writes may re-attribute it to a newer
 * tool call but must never move the content.
 *
 * Regression: Codex mints a fresh synthetic tool-use id per sub-edit and every
 * `pre_edit_snapshot` passes `replaceSpeculative: true`, so edits 2 and 3
 * overwrote the baseline with an intermediate revision and the editor showed
 * only the last sub-edit (NIM-804).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);

interface FakeRow {
  file_path: string;
  content: Buffer;
  size_bytes: number;
  timestamp: number;
  metadata: Record<string, any>;
}

const rows: FakeRow[] = [];

const query = vi.fn(async (sql: string, params: any[] = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s.startsWith("SELECT metadata->>'sessionId'")) {
    const row = rows.find(
      (r) => r.file_path === params[0] && r.metadata.status === 'pending-review',
    );
    if (!row) return { rows: [] };
    return {
      rows: [{
        session_id: row.metadata.sessionId,
        content: row.content,
        tag_id: row.metadata.tagId,
        speculative:
          row.metadata.speculative === undefined ? null : String(row.metadata.speculative),
      }],
    };
  }

  if (s.startsWith('INSERT INTO document_history')) {
    rows.push({
      file_path: params[1],
      content: params[2],
      size_bytes: params[3],
      timestamp: params[4],
      metadata: params[6],
    });
    return { rows: [] };
  }

  // createTag, authoritative-replaces-speculative: content + attribution.
  if (s.includes('SET content = $1') && s.includes('timestamp = $3')) {
    const row = rows.find(
      (r) => r.file_path === params[7] && r.metadata.tagId === params[8],
    );
    if (row) {
      row.content = params[0];
      row.size_bytes = params[1];
      row.timestamp = params[2];
      row.metadata = {
        ...row.metadata,
        tagId: params[3],
        toolUseId: params[4],
        updatedAt: params[5],
        speculative: params[6],
      };
    }
    return { rows: [] };
  }

  // updateTagContent: upgrade an empty baseline in place.
  if (s.includes('SET content = $1')) {
    const row = rows.find(
      (r) => r.file_path === params[3] && r.metadata.tagId === params[4],
    );
    if (row) {
      row.content = params[0];
      row.size_bytes = params[1];
      row.metadata = { ...row.metadata, updatedAt: params[2] };
    }
    return { rows: [] };
  }

  // createTag, attribution-only re-point of an authoritative baseline.
  if (s.includes("jsonb_set(metadata, '{tagId}'")) {
    const row = rows.find(
      (r) => r.file_path === params[3] && r.metadata.tagId === params[4],
    );
    if (row) {
      row.metadata = {
        ...row.metadata,
        tagId: params[0],
        toolUseId: params[1],
        updatedAt: params[2],
      };
    }
    return { rows: [] };
  }

  return { rows: [] };
});

vi.mock('../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    initialize: vi.fn(),
    query: (sql: string, params?: any[]) => query(sql, params),
  },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

const WORKSPACE = '/ws';
const FILE = '/ws/doc.md';
const SESSION = 'session-1';

async function pendingBaseline(): Promise<string> {
  const row = rows.find((r) => r.metadata.status === 'pending-review');
  if (!row) throw new Error('no pending tag');
  return (await gunzip(row.content)).toString('utf-8');
}

function pendingMetadata(): Record<string, any> {
  const row = rows.find((r) => r.metadata.status === 'pending-review');
  if (!row) throw new Error('no pending tag');
  return row.metadata;
}

describe('HistoryManager pre-edit baseline stability', () => {
  let historyManager: import('../HistoryManager').HistoryManager;

  beforeEach(async () => {
    rows.length = 0;
    query.mockClear();
    historyManager = (await import('../HistoryManager')).historyManager;
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('keeps the first baseline when the same session edits the file again', async () => {
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-edit-1', 'turn start', SESSION, 'tool-1',
      { replaceSpeculative: true },
    );
    // Codex sub-edit 2: new synthetic tool-use id, baseline read AFTER edit 1.
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-edit-2', 'after edit 1', SESSION, 'tool-2',
      { replaceSpeculative: true },
    );
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-edit-3', 'after edit 2', SESSION, 'tool-3',
      { replaceSpeculative: true },
    );

    expect(await pendingBaseline()).toBe('turn start');
    // Attribution still follows the newest tool call.
    expect(pendingMetadata().tagId).toBe('tag-edit-3');
    expect(pendingMetadata().toolUseId).toBe('tool-3');
  });

  it('lets an authoritative writer replace a speculative watcher baseline', async () => {
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-watcher', 'guessed baseline', SESSION, 'nimtc|bash',
      { speculative: true },
    );
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-real', 'real baseline', SESSION, 'tool-real',
      { replaceSpeculative: true },
    );

    expect(await pendingBaseline()).toBe('real baseline');
    expect(pendingMetadata().tagId).toBe('tag-real');

    // ...and having been replaced once, it is now authoritative: a later
    // sub-edit re-attributes without moving the baseline again.
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-real-2', 'after real edit', SESSION, 'tool-real-2',
      { replaceSpeculative: true },
    );
    expect(await pendingBaseline()).toBe('real baseline');
    expect(pendingMetadata().tagId).toBe('tag-real-2');
  });

  it('still upgrades an empty baseline with real content', async () => {
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-empty', '', SESSION, 'tool-1',
      { replaceSpeculative: true },
    );
    await historyManager.createTag(
      WORKSPACE, FILE, 'tag-real', 'real baseline', SESSION, 'tool-2',
      { replaceSpeculative: true },
    );

    expect(await pendingBaseline()).toBe('real baseline');
  });
});
