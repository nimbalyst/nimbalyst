import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentMessagesBackfill } from '../AgentMessagesBackfill';

interface Row {
  id: number;
  source: string;
  direction: 'input' | 'output';
  content: string;
  metadata: string | null;
  hidden: boolean | number | null;
  message_kind: string | null;
  searchable_text: string | null;
}

// Minimal in-memory adapter that understands only the queries this module
// issues. The point is to verify visit-once / no-op-second-run semantics
// at the SQL surface, not to exercise a real engine.
function makeFakeDb(seed: Row[]) {
  const table: Row[] = seed.map((r) => ({ ...r }));
  const sqlCounts = { select: 0, historicalSelect: 0, update: 0, delete: 0 };

  const query = vi.fn(async <T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('SELECT COUNT(*) AS pending FROM ai_agent_messages')) {
      const pending = table.filter((r) => r.message_kind === null).length;
      return { rows: [{ pending }] as unknown as T[] };
    }

    if (norm.startsWith('SELECT id, source, direction, content, metadata, hidden')) {
      sqlCounts.select += 1;
      const lastId = params[0] as number;
      const limit = params[1] as number;
      const rows = table
        .filter((r) => r.message_kind === null && r.id > lastId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      return { rows: rows as unknown as T[] };
    }

    if (norm.startsWith('SELECT id, content FROM ai_agent_messages')) {
      sqlCounts.historicalSelect += 1;
      const lastId = params[0] as number;
      const limit = params[1] as number;
      const rows = table
        .filter((r) =>
          r.source === 'claude-code' &&
          r.message_kind !== null &&
          r.searchable_text === null &&
          r.id > lastId
        )
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((r) => ({ id: r.id, content: r.content }));
      return { rows: rows as unknown as T[] };
    }

    if (norm.startsWith('UPDATE ai_agent_messages SET searchable_text')) {
      sqlCounts.update += 1;
      const [searchableText, messageKind, id] = params as [string | null, string | null, number];
      const row = table.find((r) => r.id === id);
      if (row) {
        row.searchable_text = searchableText;
        row.message_kind = messageKind;
      }
      return { rows: [] };
    }

    if (norm.startsWith('DELETE FROM ai_agent_messages')) {
      sqlCounts.delete += 1;
      const ids = new Set(params as number[]);
      for (let i = table.length - 1; i >= 0; i--) {
        if (ids.has(table[i].id)) table.splice(i, 1);
      }
      return { rows: [] };
    }

    throw new Error(`unexpected SQL: ${norm}`);
  });

  return { db: { query } as any, table, sqlCounts, query };
}

function makeFlagStore() {
  const flags: Record<string, boolean | undefined> = {};
  return {
    get: (key: string) => flags[key],
    set: (key: string, value: boolean) => { flags[key] = value; },
    raw: flags,
  };
}

function classifiedTransientRow(id: number, subtype: string): Row {
  // Simulates a row inserted during the Phase-1B → write-filter window:
  // message_kind was set at insert time (via the extractor, which classifies
  // claude-code system rows as 'system'), but searchable_text is NULL because
  // transient system messages produce no searchable text.
  return {
    id,
    source: 'claude-code',
    direction: 'output',
    content: JSON.stringify({ type: 'system', subtype }),
    metadata: null,
    hidden: false,
    message_kind: 'system',
    searchable_text: null,
  };
}

function classifiedSystemRow(id: number, subtype: string): Row {
  // Real (non-transient) system row that should NOT be deleted by the sweep.
  return {
    id,
    source: 'claude-code',
    direction: 'output',
    content: JSON.stringify({ type: 'system', subtype }),
    metadata: null,
    hidden: false,
    message_kind: 'system',
    searchable_text: null,
  };
}

function transientRow(id: number, subtype: string): Row {
  return {
    id,
    source: 'claude-code',
    direction: 'output',
    content: JSON.stringify({ type: 'system', subtype }),
    metadata: null,
    hidden: false,
    message_kind: null,
    searchable_text: null,
  };
}

function userRow(id: number, prompt: string): Row {
  return {
    id,
    source: 'claude-code',
    direction: 'input',
    content: JSON.stringify({ prompt }),
    metadata: null,
    hidden: false,
    message_kind: null,
    searchable_text: null,
  };
}

describe('runAgentMessagesBackfill', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('classifies non-transient rows and deletes transient ones on first run', async () => {
    const { db, table, sqlCounts } = makeFakeDb([
      userRow(1, 'hello'),
      transientRow(2, 'hook_started'),
      userRow(3, 'how are you'),
      transientRow(4, 'task_progress'),
      userRow(5, 'goodbye'),
    ]);

    const stats = await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore: makeFlagStore() });

    expect(stats.searchableTextBackfilled).toBe(3);
    expect(stats.transientsDeleted).toBe(2);
    expect(sqlCounts.select).toBeGreaterThan(0);
    expect(sqlCounts.update).toBe(3);
    expect(sqlCounts.delete).toBe(1); // batched into one statement

    // Transients are gone; survivors are classified.
    expect(table.map((r) => r.id).sort()).toEqual([1, 3, 5]);
    for (const row of table) {
      expect(row.message_kind).not.toBeNull();
    }
    warn.mockRestore();
  });

  it('is a no-op on a second run (visit-once semantics)', async () => {
    const { db, sqlCounts } = makeFakeDb([
      userRow(1, 'hello'),
      transientRow(2, 'hook_started'),
      userRow(3, 'how are you'),
    ]);

    const flagStore = makeFlagStore();
    await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore });

    // Reset call counters and run again. The first run drained every NULL row
    // cleanly, so it set the completion flag -- the second run must skip the
    // extractor pass ENTIRELY (no SELECT at all), not just match zero rows.
    // This is the NIM-899 fix: a completed DB never re-scans ai_agent_messages.
    sqlCounts.select = 0;
    sqlCounts.historicalSelect = 0;
    sqlCounts.update = 0;
    sqlCounts.delete = 0;

    const stats = await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore });

    expect(stats.searchableTextBackfilled).toBe(0);
    expect(stats.transientsDeleted).toBe(0);
    expect(stats.historicalTransientsDeleted).toBe(0);
    expect(sqlCounts.select).toBe(0);
    expect(sqlCounts.historicalSelect).toBe(0);
    expect(sqlCounts.update).toBe(0);
    expect(sqlCounts.delete).toBe(0);
    warn.mockRestore();
  });

  it('does NOT set the completion flag when a row UPDATE fails (must retry next startup)', async () => {
    const { db, query } = makeFakeDb([userRow(1, 'hello'), userRow(2, 'world')]);
    // Make the UPDATE for row 2 throw so the pass cannot drain cleanly.
    const realQuery = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('UPDATE ai_agent_messages SET searchable_text') && params[2] === 2) {
        throw new Error('simulated UPDATE failure');
      }
      return realQuery(sql, params);
    });

    const flagStore = makeFlagStore();
    await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore });

    // A failed row stays message_kind NULL, so the completion flag must stay
    // unset and the next startup must re-run the pass.
    expect(flagStore.raw['agentMessagesSearchableBackfillCompleteV1']).toBeUndefined();
    warn.mockRestore();
  });

  it('skips the extractor pass when the completion flag is already set', async () => {
    const { db, sqlCounts } = makeFakeDb([userRow(1, 'pending')]);
    const flagStore = makeFlagStore();
    flagStore.set('agentMessagesSearchableBackfillCompleteV1', true);

    const stats = await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore });

    expect(stats.searchableTextBackfilled).toBe(0);
    expect(sqlCounts.select).toBe(0);
    expect(sqlCounts.update).toBe(0);
    warn.mockRestore();
  });

  it('walks across multiple chunks without revisiting rows', async () => {
    const seed: Row[] = [];
    for (let i = 1; i <= 7; i++) seed.push(userRow(i, `prompt ${i}`));
    const { db, sqlCounts } = makeFakeDb(seed);

    const stats = await runAgentMessagesBackfill(db, { chunkSize: 2, flagStore: makeFlagStore() });

    expect(stats.searchableTextBackfilled).toBe(7);
    expect(stats.transientsDeleted).toBe(0);
    // 7 rows / chunk 2 = 4 SELECTs (2+2+2+1), then the next SELECT is skipped
    // because rows.length < chunkSize triggers the loop break.
    expect(sqlCounts.select).toBe(4);
    expect(sqlCounts.update).toBe(7);
    warn.mockRestore();
  });

  it('respects deleteTransients=false (transients are classified, not deleted)', async () => {
    const { db, table, sqlCounts } = makeFakeDb([
      userRow(1, 'hello'),
      transientRow(2, 'hook_started'),
    ]);

    const flagStore = makeFlagStore();
    const stats = await runAgentMessagesBackfill(db, {
      chunkSize: 10,
      deleteTransients: false,
      flagStore,
    });

    expect(stats.transientsDeleted).toBe(0);
    expect(stats.historicalTransientsDeleted).toBe(0);
    expect(sqlCounts.delete).toBe(0);
    // Both rows are now classified; nothing was removed.
    expect(table).toHaveLength(2);
    for (const row of table) {
      expect(row.message_kind).not.toBeNull();
    }
    // deleteTransients=false also disables the historical sweep — the flag
    // must NOT be set, otherwise a later run with deleteTransients=true would
    // skip its sweep entirely.
    expect(flagStore.raw['agentMessagesTransientHistoricalCleanupV1']).toBeUndefined();
    warn.mockRestore();
  });

  describe('historical transient sweep', () => {
    it('deletes already-classified transient claude-code rows on first run', async () => {
      // Mix of rows that survived the Phase-1B → write-filter window:
      // - Two transient rows already classified as 'system' (the bug)
      // - One real system row that must be preserved
      // - One legitimately-NULL row that the main pass handles
      const { db, table, sqlCounts } = makeFakeDb([
        classifiedTransientRow(1, 'hook_started'),
        classifiedSystemRow(2, 'init'),
        classifiedTransientRow(3, 'task_progress'),
        userRow(4, 'still pending classification'),
      ]);

      const flagStore = makeFlagStore();
      const stats = await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore });

      expect(stats.searchableTextBackfilled).toBe(1); // row 4
      expect(stats.transientsDeleted).toBe(0); // row 4 is a userRow, not transient
      expect(stats.historicalTransientsDeleted).toBe(2); // rows 1 and 3
      expect(sqlCounts.historicalSelect).toBeGreaterThan(0);
      expect(table.map((r) => r.id).sort()).toEqual([2, 4]);
      expect(flagStore.raw['agentMessagesTransientHistoricalCleanupV1']).toBe(true);
      warn.mockRestore();
    });

    it('skips the historical sweep entirely when the flag is already set', async () => {
      const { db, sqlCounts } = makeFakeDb([
        classifiedTransientRow(1, 'hook_started'),
        classifiedTransientRow(2, 'task_progress'),
      ]);

      const flagStore = makeFlagStore();
      flagStore.set('agentMessagesTransientHistoricalCleanupV1', true);

      const stats = await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore });

      // No historical SELECT issued, no DELETEs, table unchanged.
      expect(stats.historicalTransientsDeleted).toBe(0);
      expect(sqlCounts.historicalSelect).toBe(0);
      expect(sqlCounts.delete).toBe(0);
      warn.mockRestore();
    });

    it('does not delete classified-non-transient claude-code system rows', async () => {
      const { db, table } = makeFakeDb([
        classifiedSystemRow(1, 'init'),
        classifiedSystemRow(2, 'shutdown'),
      ]);

      const flagStore = makeFlagStore();
      const stats = await runAgentMessagesBackfill(db, { chunkSize: 10, flagStore });

      expect(stats.historicalTransientsDeleted).toBe(0);
      expect(table).toHaveLength(2);
      // Flag still gets set: we did walk the candidates, we just didn't match
      // any. Second run must short-circuit.
      expect(flagStore.raw['agentMessagesTransientHistoricalCleanupV1']).toBe(true);
      warn.mockRestore();
    });
  });
});
