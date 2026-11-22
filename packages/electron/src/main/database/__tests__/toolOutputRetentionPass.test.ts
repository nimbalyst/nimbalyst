// @vitest-environment node
/**
 * Exercises the retention pass against a real in-memory better-sqlite3
 * database, because the invariants that matter here are about ROW SELECTION --
 * which rows the SQL admits and which it must never touch. A mocked handle
 * would assert the query I wrote rather than the query the database runs.
 */
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import {
  createToolOutputRetentionWork,
  createRawMessagePruneWork,
  createInitDedupWork,
  estimateReclaimableBytes,
} from '../toolOutputRetentionPass';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';
const RECENT = '2026-08-18T00:00:00.000Z';
const BIG = 'stdout line\n'.repeat(4000);

function toolResult(content: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content }] },
  });
}

function toolUse(fileContent: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: { content: fileContent } }],
    },
  });
}

function makeDb(): SqliteDatabase {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE ai_agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      message_kind TEXT
    );
    INSERT INTO ai_sessions (id, status)
      VALUES ('idle-session', 'idle'), ('live-session', 'running'), ('other-session', 'idle');
  `);
  return db;
}

function insert(
  db: SqliteDatabase,
  row: Partial<{
    session: string;
    createdAt: string;
    source: string;
    direction: string;
    content: string;
    kind: string;
    metadata: Record<string, unknown>;
  }>,
): number {
  const info = db
    .prepare(
      `INSERT INTO ai_agent_messages
         (session_id, created_at, source, direction, content, metadata, message_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.session ?? 'idle-session',
      row.createdAt ?? OLD,
      row.source ?? 'claude-code',
      row.direction ?? 'output',
      row.content ?? toolResult(BIG),
      row.metadata ? JSON.stringify(row.metadata) : null,
      row.kind ?? 'tool',
    );
  return Number(info.lastInsertRowid);
}

/** Insert at an explicit id, to lay out a deliberate id distribution. */
function insertAt(db: SqliteDatabase, id: number, content: string): void {
  db.prepare(
    `INSERT INTO ai_agent_messages (id, session_id, created_at, source, direction, content, message_kind)
     VALUES (?, 'idle-session', ?, 'claude-code', 'output', ?, 'tool')`,
  ).run(id, OLD, content);
}

/** Drive the chunk loop to completion, as runBackground would. */
function runPass(db: SqliteDatabase, retentionDays = 30) {
  let result: any = null;
  const work = createToolOutputRetentionWork(
    { retentionDays, now: () => NOW },
    (r) => { result = r; },
  );
  for (let i = 0; i < 100; i++) {
    if (work.chunk(db).done) break;
  }
  return result;
}

function contentOf(db: SqliteDatabase, id: number): string {
  return (db.prepare('SELECT content FROM ai_agent_messages WHERE id = ?').get(id) as any).content;
}

describe('tool output retention pass', () => {
  it('tombstones aged tool output and reports the bytes saved', () => {
    const db = makeDb();
    const id = insert(db, {});
    const before = contentOf(db, id).length;

    const result = runPass(db);

    expect(result.rewritten).toBe(1);
    expect(result.bytesSaved).toBeGreaterThan(before / 2);
    expect(contentOf(db, id)).toContain('Output discarded to reclaim disk');
  });

  it('resumes after startAfterId and reports the last id it examined', () => {
    const db = makeDb();
    const first = insert(db, {});
    const second = insert(db, {});
    const before = contentOf(db, first);

    let result: any = null;
    const work = createToolOutputRetentionWork(
      { retentionDays: 30, now: () => NOW, startAfterId: first },
      (r) => { result = r; },
    );
    for (let i = 0; i < 100 && !work.chunk(db).done; i++) { /* drive */ }

    expect(contentOf(db, first)).toBe(before);
    expect(result.rewritten).toBe(1);
    expect(result.lastId).toBe(second);
  });

  it('stops at the first row still inside the window, so that row is reached once it ages', () => {
    // Ids and timestamps do not rise together: an imported or copied row keeps
    // its old timestamp at a new id. Advancing the cursor to that row skipped
    // every younger row below it for good.
    const db = makeDb();
    const aged = insert(db, {});
    const young = insert(db, { createdAt: RECENT });
    const agedAtHighId = insert(db, {});

    const run = (now: number, startAfterId: number) => {
      let result: any = null;
      const work = createToolOutputRetentionWork(
        { retentionDays: 30, now: () => now, startAfterId },
        (r) => { result = r; },
      );
      for (let i = 0; i < 100 && !work.chunk(db).done; i++) { /* drive */ }
      return result;
    };

    const first = run(NOW, 0);
    expect(first.lastId).toBe(aged);
    expect(first.stoppedEarly).toBe(false);
    expect(contentOf(db, aged)).toContain('Output discarded to reclaim disk');

    const sixtyDaysLater = NOW + 60 * 24 * 60 * 60 * 1000;
    const second = run(sixtyDaysLater, first.lastId);
    expect(contentOf(db, young)).toContain('Output discarded to reclaim disk');
    expect(contentOf(db, agedAtHighId)).toContain('Output discarded to reclaim disk');
    expect(second.lastId).toBe(agedAtHighId);
  });

  it('walks past a row dated in the future instead of stopping at it forever', () => {
    const db = makeDb();
    insert(db, { createdAt: '2099-01-01T00:00:00.000Z' });
    const aged = insert(db, {});

    const result = runPass(db);

    expect(contentOf(db, aged)).toContain('Output discarded to reclaim disk');
    expect(result.lastId).toBe(aged);
  });

  it('tombstones codex command output under both the old meta and the new tool label', () => {
    const db = makeDb();
    const commandCompleted = JSON.stringify({
      method: 'item/completed',
      params: { item: { id: 'c1', type: 'commandExecution', command: 'ls', aggregatedOutput: BIG } },
    });
    const notYetBackfilled = insert(db, { source: 'openai-codex', kind: 'meta', content: commandCompleted });
    const relabeled = insert(db, { source: 'openai-codex', kind: 'tool', content: commandCompleted });
    // A lifecycle frame is `system` now and must never be read by this lane.
    const lifecycle = JSON.stringify({ method: 'turn/completed', params: { usage: { blob: BIG } } });
    const turnCompleted = insert(db, { source: 'openai-codex', kind: 'system', content: lifecycle });

    const result = runPass(db);

    expect(result.scanned).toBe(2);
    expect(contentOf(db, notYetBackfilled)).toContain('Output discarded to reclaim disk');
    expect(contentOf(db, relabeled)).toContain('Output discarded to reclaim disk');
    expect(contentOf(db, turnCompleted)).toBe(lifecycle);
  });

  it('never touches user prompts', () => {
    const db = makeDb();
    const id = insert(db, { direction: 'input', kind: 'user', content: toolResult(BIG) });
    const before = contentOf(db, id);

    runPass(db);

    expect(contentOf(db, id)).toBe(before);
  });

  it('never touches assistant text', () => {
    const db = makeDb();
    const id = insert(db, { kind: 'assistant', content: toolResult(BIG) });
    const before = contentOf(db, id);

    runPass(db);

    expect(contentOf(db, id)).toBe(before);
  });

  it('never touches a tool_use call, however large the file it wrote', () => {
    const db = makeDb();
    const id = insert(db, { content: toolUse('plan line\n'.repeat(8000)) });
    const before = contentOf(db, id);

    runPass(db);

    expect(contentOf(db, id)).toBe(before);
  });

  it('never touches rows newer than the retention window', () => {
    const db = makeDb();
    const id = insert(db, { createdAt: RECENT });
    const before = contentOf(db, id);

    runPass(db);

    expect(contentOf(db, id)).toBe(before);
  });

  it('never touches a session that is still running', () => {
    const db = makeDb();
    const id = insert(db, { session: 'live-session' });
    const before = contentOf(db, id);

    runPass(db);

    expect(contentOf(db, id)).toBe(before);
  });

  it('is idempotent across runs', () => {
    const db = makeDb();
    const id = insert(db, {});

    const first = runPass(db);
    const afterFirst = contentOf(db, id);
    const second = runPass(db);

    expect(first.rewritten).toBe(1);
    expect(second.rewritten).toBe(0);
    expect(contentOf(db, id)).toBe(afterFirst);
  });

  it('bounds every chunk rather than scanning the whole table', () => {
    // The regression this guards is an app hang, not a wrong value: an
    // unbounded scan of this table held the SQLite worker for 35s at a time.
    const db = makeDb();
    for (let i = 0; i < 900; i++) insert(db, {});

    const prepare = vi.spyOn(db, 'prepare');
    runPass(db);

    const selects = prepare.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes('FROM ai_agent_messages'));
    expect(selects.length).toBeGreaterThan(0);
    for (const sql of selects) expect(sql).toContain('LIMIT');
  });

  it('estimates from a bounded sample without reading every row', () => {
    const db = makeDb();
    for (let i = 0; i < 50; i++) insert(db, {});

    const est = estimateReclaimableBytes(db, 30, NOW);

    expect(est.candidateRows).toBe(50);
    expect(est.estimatedBytesSaved).toBeGreaterThan(0);
    expect(est.sampledRows).toBeLessThanOrEqual(2000);
  });

  it('counts every candidate row rather than saturating at a cost guard', () => {
    // Regression: the count was once wrapped in LIMIT 1000000 as a cost guard.
    // On a real 10 GB store it saturated at exactly that value and reported
    // ~1.4 GB reclaimable instead of ~3.9 GB -- a wrong number that looks
    // precise and reads LOW, talking the user out of space they need.
    const db = makeDb();
    const total = 2500;
    for (let i = 0; i < total; i++) insert(db, {});

    const est = estimateReclaimableBytes(db, 30, NOW);

    expect(est.candidateRows).toBe(total);
    // Sampling still bounds the expensive half (the content reads).
    expect(est.sampledRows).toBeLessThan(total);
    // Extrapolation scales the sample to the FULL population.
    const expected = (est.sampleBytesSaved / est.sampledRows) * total;
    expect(est.estimatedBytesSaved).toBeCloseTo(expected, -3);
    expect(est.estimatedBytesSaved).toBeGreaterThan(est.sampleBytesSaved);
  });

  it('spreads its sample across the id range instead of one contiguous run', () => {
    // The defect behind NIM-3661. The sampler took the first N candidates after
    // each window cursor -- on the real install that was ~125 CONSECUTIVE ids
    // out of a 200,000-id window, eight times over, each run belonging to a
    // single session. Every probe landed in the same barren stretch and the
    // estimate reported 0 reclaimable against 1,020,087 candidate rows.
    //
    // Here the first 400 ids hold nothing worth reclaiming and the entire
    // reclaimable mass sits further up the id range, which is exactly the
    // layout the old sampler could not see past.
    const db = makeDb();
    for (let id = 1; id <= 400; id++) insertAt(db, id, toolResult('ok'));
    for (let id = 30_000; id < 30_400; id++) insertAt(db, id, toolResult(BIG));

    const est = estimateReclaimableBytes(db, 30, NOW);

    expect(est.candidateRows).toBe(800);
    expect(est.probesTaken).toBeGreaterThan(1);
    expect(est.sampleBytesSaved).toBeGreaterThan(0);
    expect(est.estimatedBytesSaved).toBeGreaterThan(0);
  });

  it('bounds each sampling probe above as well as below', () => {
    // A probe with only `id > ?` keeps scanning past its region hunting for
    // LIMIT matches, which is how a "bounded" estimate becomes a long scan on
    // a sparse table. Every sampling statement must carry an upper bound.
    const db = makeDb();
    for (let i = 0; i < 40; i++) insert(db, {});

    const prepare = vi.spyOn(db, 'prepare');
    estimateReclaimableBytes(db, 30, NOW);

    const samplers = prepare.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes('m.content'));
    expect(samplers.length).toBeGreaterThan(0);
    for (const sql of samplers) {
      expect(sql).toContain('m.id > ?');
      expect(sql).toContain('m.id <= ?');
      expect(sql).toContain('LIMIT');
    }
  });

  it('never counts rows it would refuse to rewrite', () => {
    const db = makeDb();
    for (let i = 0; i < 10; i++) insert(db, {});
    insert(db, { direction: 'input', kind: 'user' });
    insert(db, { kind: 'assistant' });
    insert(db, { session: 'live-session' });
    insert(db, { createdAt: RECENT });

    expect(estimateReclaimableBytes(db, 30, NOW).candidateRows).toBe(10);
  });
});

describe('estimate confidence', () => {
  // A bare `estimatedBytesSaved: 0` means two completely different things --
  // "there is nothing to reclaim" and "I barely looked" -- and the second one
  // cost a full investigation before anyone questioned the number. The result
  // has to say which it is.
  it('says the sample found nothing rather than implying the table is clean', () => {
    const db = makeDb();
    for (let i = 0; i < 20; i++) insert(db, { content: toolResult('ok') });

    const est = estimateReclaimableBytes(db, 30, NOW);

    expect(est.candidateRows).toBe(20);
    expect(est.estimatedBytesSaved).toBe(0);
    expect(est.lowConfidence).toBe(true);
    expect(est.note).toMatch(/floor, not a guarantee/);
  });

  it('distinguishes an empty candidate set from an uninformative sample', () => {
    const db = makeDb();

    const est = estimateReclaimableBytes(db, 30, NOW);

    expect(est.candidateRows).toBe(0);
    expect(est.lowConfidence).toBe(false);
    expect(est.note).toMatch(/No rows are old enough/);
  });

  it('reports coverage so a thin sample cannot pass as a survey', () => {
    const db = makeDb();
    for (let i = 0; i < 300; i++) insert(db, {});

    const est = estimateReclaimableBytes(db, 30, NOW);

    expect(est.sampleCoverage).toBeGreaterThan(0);
    expect(est.sampleCoverage).toBeLessThanOrEqual(1);
    expect(est.probesTaken).toBeGreaterThan(0);
  });
});

/** Drive the prune lane to completion, as runBackground would. */
function runPrune(db: SqliteDatabase, retentionDays = 30, ignoreAge = false) {
  let result: any = null;
  const work = createRawMessagePruneWork(
    { retentionDays, ignoreAge, now: () => NOW },
    (r) => { result = r; },
  );
  for (let i = 0; i < 100; i++) {
    if (work.chunk(db).done) break;
  }
  return result;
}

function runInitDedup(db: SqliteDatabase) {
  let result: any = null;
  const work = createInitDedupWork({ now: () => NOW }, (r) => { result = r; });
  for (let i = 0; i < 100; i++) {
    if (work.chunk(db).done) break;
  }
  return result;
}

const exists = (db: SqliteDatabase, id: number): boolean =>
  db.prepare('SELECT 1 FROM ai_agent_messages WHERE id = ?').get(id) !== undefined;

const thinkingTick = JSON.stringify({
  type: 'system', subtype: 'thinking_tokens', estimated_tokens: 250, estimated_tokens_delta: 100,
});
const initFrame = (n: number) =>
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: Array(n).fill('Tool') });

/** A codex `item/agentMessage/delta` row, optionally anonymous about its item. */
function codexDelta(db: SqliteDatabase, itemId: string | null, session = 'idle-session'): number {
  return insert(db, {
    session, source: 'openai-codex', kind: 'meta',
    metadata: { eventType: 'item/agentMessage/delta' },
    content: JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't', turnId: 'turn', ...(itemId ? { itemId } : {}), delta: ' partial' },
    }),
  });
}

/** The codex row that supersedes a delta: same item id, later row id. */
function codexItemCompleted(db: SqliteDatabase, itemId: string, session = 'idle-session'): number {
  return insert(db, {
    session, source: 'openai-codex', kind: 'meta',
    metadata: { eventType: 'item/completed' },
    content: JSON.stringify({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: itemId, text: 'Done.' }, threadId: 't', turnId: 'turn' },
    }),
  });
}

/** The start of a turn: every provider logs the user's prompt before it runs. */
const turnStart = (db: SqliteDatabase, session = 'idle-session') =>
  insert(db, { session, source: 'grok-build', direction: 'input', kind: 'user', content: 'go' });

const grokTextDelta = (db: SqliteDatabase, session = 'idle-session') => insert(db, {
  session, source: 'grok-build', kind: 'meta',
  content: JSON.stringify({ type: 'text', data: 'partial answer' }),
});

const grokThoughtDelta = (db: SqliteDatabase, session = 'idle-session') => insert(db, {
  session, source: 'grok-build', kind: 'meta',
  content: JSON.stringify({ type: 'thought', data: 'let me think' }),
});

/** What `HeadlessCliAgentProvider.storeAssistantResponse` writes at `complete`. */
const grokTurnFinal = (db: SqliteDatabase, session = 'idle-session') => insert(db, {
  session, source: 'grok-build', kind: 'assistant',
  metadata: { eventType: 'item.completed' },
  content: JSON.stringify({
    type: 'item.completed',
    item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
  }),
});

describe('raw message prune lane', () => {
  it('deletes aged non-rendering frames and reports why', () => {
    const db = makeDb();
    const tick = insert(db, { content: thinkingTick, kind: 'system' });
    const status = insert(db, {
      source: 'openai-codex', kind: 'meta',
      content: JSON.stringify({ method: 'thread/tokenUsage/updated', params: { tokenUsage: {} } }),
    });
    const delta = codexDelta(db, 'msg_1');
    codexItemCompleted(db, 'msg_1');
    const started = insert(db, {
      source: 'openai-codex', kind: 'meta',
      content: JSON.stringify({ method: 'item/started', params: { item: { type: 'reasoning' } } }),
    });

    const result = runPrune(db);

    expect(result.deleted).toBe(4);
    expect(result.byReason).toEqual({
      claudeCodeTransient: 1, codexAppServerStatus: 1, codexAgentMessageDelta: 1,
      codexCommandOutputDelta: 0, codexItemStartedNonRendering: 1,
      headlessAgentTextDelta: 0, grokAcpTextDelta: 0, grokAvailableCommands: 0,
    });
    expect(result.bytesFreed).toBeGreaterThan(0);
    for (const id of [tick, status, delta, started]) expect(exists(db, id)).toBe(false);
  });

  // Every guard the tombstone lane has, the prune lane must have too -- it is
  // strictly more destructive.
  it('never touches recent rows, input, live sessions, or rendering frames', () => {
    const db = makeDb();
    const survivors = [
      insert(db, { content: thinkingTick, kind: 'system', createdAt: RECENT }),
      insert(db, { content: thinkingTick, kind: 'system', direction: 'input' }),
      insert(db, { content: thinkingTick, kind: 'system', session: 'live-session' }),
      insert(db, { content: initFrame(3), kind: 'system' }),
      insert(db, { content: toolResult(BIG) }),
      insert(db, { content: toolUse('x') }),
      insert(db, {
        source: 'openai-codex', kind: 'meta',
        content: JSON.stringify({ method: 'item/started', params: { item: { type: 'mcpToolCall' } } }),
      }),
    ];

    const result = runPrune(db);

    expect(result.deleted).toBe(0);
    for (const id of survivors) expect(exists(db, id)).toBe(true);
  });

  it('is idempotent', () => {
    const db = makeDb();
    insert(db, { content: thinkingTick, kind: 'system' });
    expect(runPrune(db).deleted).toBe(1);
    expect(runPrune(db).deleted).toBe(0);
  });

  // The classifier calls a headless delta "superseded by the turn-final
  // item.completed", and that row is written from exactly one place: the
  // provider's `case 'complete':`. A turn the user cancels, or whose CLI dies
  // mid-stream, never reaches it -- and then these deltas are the ONLY record
  // of what the assistant said, with no server-side copy to restore from. None
  // of that is visible in the row, so the driver has to prove it.
  // The correction that matters most. `id`-ordered append-only storage makes "a
  // later item.completed exists in this session" true for a turn that never
  // stored one, as long as SOME later turn did. Three turns is the smallest
  // layout that shows it, and the cancelled turn in the middle is the one whose
  // partial response has no other copy anywhere.
  it('does not let a later turn vouch for a cancelled turn between two completed ones', () => {
    const db = makeDb();

    turnStart(db);
    const turnAdelta = grokTextDelta(db);
    grokTurnFinal(db);

    turnStart(db);
    const cancelledTurnBdelta = grokTextDelta(db);

    turnStart(db);
    const turnCdelta = grokTextDelta(db);
    grokTurnFinal(db);

    runPrune(db);

    expect(exists(db, cancelledTurnBdelta)).toBe(true);
    // The turns that did complete are still reclaimed, so the guard is scoped
    // rather than simply refusing everything.
    expect(exists(db, turnAdelta)).toBe(false);
    expect(exists(db, turnCdelta)).toBe(false);
  });

  // `fullText` in HeadlessCliAgentProvider accumulates `case 'text':` only --
  // its `case 'reasoning':` is a bare break -- so the turn-final item.completed
  // it synthesizes carries assistant text and no reasoning at all. A thought
  // delta is therefore the sole copy of the agent's thinking even for a turn
  // that completed perfectly, which is the opposite of superseded.
  it('never deletes a reasoning delta, even for a turn that completed', () => {
    const db = makeDb();

    turnStart(db);
    const thought = grokThoughtDelta(db);
    const text = grokTextDelta(db);
    grokTurnFinal(db);

    const result = runPrune(db);

    expect(exists(db, thought)).toBe(true);
    // Same turn, same proof: the text delta really is superseded and goes.
    expect(exists(db, text)).toBe(false);
    expect(result.keptAwaitingTurnFinal).toBe(0);
  });

  // The prompt row is written best-effort, so a session with none of them is a
  // session whose turn boundaries were lost -- not one that had no turns. With
  // nothing to scope against, answering from the session as a whole is exactly
  // the rule that deleted a cancelled turn's only copy.
  it('keeps headless deltas in a session whose turn boundaries were never logged', () => {
    const db = makeDb();
    const orphaned = grokTextDelta(db);
    grokTurnFinal(db);

    const result = runPrune(db);

    expect(exists(db, orphaned)).toBe(true);
    expect(result.keptAwaitingTurnFinal).toBe(1);
  });

  // Historical codex deltas reached the lane through a reason shared with pure
  // status notifications, so they were deleted with no proof of supersession at
  // all -- the largest population in the table bypassing the guard entirely.
  it('prunes a codex delta only once its own item completed', () => {
    const db = makeDb();

    const proven = codexDelta(db, 'msg_done');
    const cancelledMidMessage = codexDelta(db, 'msg_never');
    const anonymous = codexDelta(db, null);
    codexItemCompleted(db, 'msg_done');
    // A completion for a DIFFERENT item, later than every delta above: it must
    // not vouch for any of them.
    codexItemCompleted(db, 'msg_unrelated');
    // Same item id, but in another session -- sessions never vouch for each other.
    codexDelta(db, 'msg_other', 'other-session');

    const result = runPrune(db);

    expect(exists(db, proven)).toBe(false);
    expect(exists(db, cancelledMidMessage)).toBe(true);
    expect(exists(db, anonymous)).toBe(true);
    expect(result.keptAwaitingItemCompleted).toBe(3);
  });

  it('prunes a headless delta only once its turn stored a final message', () => {
    const db = makeDb();
    const grokDelta = (session: string) => insert(db, {
      session, source: 'grok-build', kind: 'meta',
      content: JSON.stringify({ type: 'text', data: 'partial answer' }),
    });
    const grokAcpDelta = (session: string) => insert(db, {
      session, source: 'grok-build', kind: 'meta',
      content: JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: session,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } },
        },
      }),
    });

    // One turn, so nothing that follows these deltas belongs to a later one.
    turnStart(db);
    const completedTurn = grokDelta('idle-session');
    const completedAcpTurn = grokAcpDelta('idle-session');
    // Same session and an EARLIER id than the completion below, but a different
    // provider -- one provider's turn cannot vouch for another's deltas.
    const otherProvider = insert(db, {
      session: 'idle-session', source: 'cursor-agent', kind: 'meta',
      content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    });
    const turnFinal = insert(db, {
      session: 'idle-session', source: 'grok-build', kind: 'assistant',
      metadata: { eventType: 'item.completed' },
      content: JSON.stringify({
        type: 'item.completed',
        item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      }),
    });
    // Cancelled last turn: a completion exists in this session, but before it.
    const cancelledTurn = grokDelta('idle-session');
    const cancelledAcpTurn = grokAcpDelta('idle-session');
    // A session that never completed a turn at all.
    turnStart(db, 'other-session');
    const neverCompleted = grokDelta('other-session');
    // The command catalog is a static built-in, superseded by nothing, so it
    // carries no such premise and needs no proof.
    const catalog = insert(db, {
      session: 'other-session', source: 'grok-build', kind: 'meta',
      content: JSON.stringify({ type: 'available_commands', commands: [{ name: 'read_file' }] }),
    });

    const result = runPrune(db);

    expect(exists(db, completedTurn)).toBe(false);
    expect(exists(db, completedAcpTurn)).toBe(false);
    expect(exists(db, catalog)).toBe(false);
    for (const id of [otherProvider, turnFinal, cancelledTurn, cancelledAcpTurn, neverCompleted]) {
      expect(exists(db, id)).toBe(true);
    }
    expect(result.keptAwaitingTurnFinal).toBe(4);
    expect(result.byReason.headlessAgentTextDelta).toBe(1);
    expect(result.byReason.grokAcpTextDelta).toBe(1);
    expect(result.byReason.grokAvailableCommands).toBe(1);
  });

  // A frame that renders nothing renders nothing on the day it is written, so
  // this lane can drop the age gate. The session-status guard is what actually
  // protects a turn in flight, and it still applies.
  it('with ignoreAge, takes recent dead frames but still spares live sessions', () => {
    const db = makeDb();
    const recentTick = insert(db, { content: thinkingTick, kind: 'system', createdAt: RECENT });
    const liveTick = insert(db, {
      content: thinkingTick, kind: 'system', createdAt: RECENT, session: 'live-session',
    });
    const realOutput = insert(db, { content: toolResult(BIG), createdAt: RECENT });

    const result = runPrune(db, 30, true);

    expect(result.deleted).toBe(1);
    expect(exists(db, recentTick)).toBe(false);
    expect(exists(db, liveTick)).toBe(true);
    expect(exists(db, realOutput)).toBe(true);
  });
});

describe('claude-code init dedup lane', () => {
  it('keeps the newest init per session and deletes the rest', () => {
    const db = makeDb();
    const first = insert(db, { content: initFrame(5), kind: 'system' });
    const second = insert(db, { content: initFrame(6), kind: 'system' });
    const newest = insert(db, { content: initFrame(7), kind: 'system' });
    const otherSession = insert(db, {
      content: initFrame(2), kind: 'system', session: 'live-session',
    });

    const result = runInitDedup(db);

    expect(result.deleted).toBe(2);
    expect(exists(db, first)).toBe(false);
    expect(exists(db, second)).toBe(false);
    // Newest survives, and a running session is never touched at all.
    expect(exists(db, newest)).toBe(true);
    expect(exists(db, otherSession)).toBe(true);
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  it('leaves a session with a single init alone, and is idempotent', () => {
    const db = makeDb();
    const only = insert(db, { content: initFrame(4), kind: 'system' });
    expect(runInitDedup(db).deleted).toBe(0);
    expect(exists(db, only)).toBe(true);
  });
});
