import { gzipSync } from 'zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';

// Use the REAL ToolCallMatcher (unlike TranscriptToolCallEnricher.test.ts, which
// mocks it) so this test exercises the actual per-session query fan-out. Mock
// only the leaf dependencies: the database, disk, logger, and the transcript
// runtime.
const dbMock = vi.hoisted(() => ({ query: vi.fn(), engine: 'sqlite' as string }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    initialize: vi.fn(),
    getEngine: () => dbMock.engine,
    query: dbMock.query,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({
  TranscriptMigrationRepository: { hasService: () => false, getService: () => ({}) },
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: vi.fn().mockResolvedValue({ provider: 'openai-codex', workspaceId: '/repo' }),
  },
}));

const fsMock = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('fs/promises', () => ({ readFile: fsMock.readFile, default: { readFile: fsMock.readFile } }));

import { enrichTranscriptMessagesWithToolCallDiffs } from '../TranscriptToolCallEnricher';

const SESSION_ID = 'session-batch';
const BEFORE = gzipSync(Buffer.from('line1\nBEFORE\nline3\n'));

function fileChangeMessage(toolUseId: string, ts: number): TranscriptViewMessage {
  return {
    id: ts,
    sequence: ts,
    createdAt: new Date(ts),
    type: 'tool_call',
    subagentId: null,
    toolCall: {
      toolName: 'file_change',
      toolDisplayName: 'file_change',
      providerToolCallId: toolUseId,
      status: 'completed',
      description: null,
      arguments: {},
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      progress: [],
      result: 'ok',
    },
  } as unknown as TranscriptViewMessage;
}

function editedSessionFiles() {
  // Three tool calls all editing the same file (mirrors the reported session:
  // 1292 edited links over ~219 distinct files).
  return [
    { id: 'sf1', file_path: '/repo/a.ts', timestamp_ms: 1_000_000_000_100, metadata: { toolUseId: 'tc-1', operation: 'edit' } },
    { id: 'sf2', file_path: '/repo/a.ts', timestamp_ms: 1_000_000_000_200, metadata: { toolUseId: 'tc-2', operation: 'edit' } },
    { id: 'sf3', file_path: '/repo/a.ts', timestamp_ms: 1_000_000_000_300, metadata: { toolUseId: 'tc-3', operation: 'edit' } },
  ];
}

function preEditRows() {
  return [
    { file_path: '/repo/a.ts', content: BEFORE, metadata: { toolUseId: 'tc-3' }, tool_use_id: 'tc-3' },
    { file_path: '/repo/a.ts', content: BEFORE, metadata: { toolUseId: 'tc-2' }, tool_use_id: 'tc-2' },
    { file_path: '/repo/a.ts', content: BEFORE, metadata: { toolUseId: 'tc-1' }, tool_use_id: 'tc-1' },
  ];
}

describe('enrichTranscriptMessagesWithToolCallDiffs batching', () => {
  beforeEach(() => {
    dbMock.query.mockReset();
    fsMock.readFile.mockReset();
    fsMock.readFile.mockResolvedValue('line1\nAFTER\nline3\n');
    // Reset the ToolCallMatcher diff cache so counts are per-test.
    // (createSessionEnrichmentContext repopulates it.)

    dbMock.query.mockImplementation(async (sql: string) => {
      if (/workspace_id/.test(sql)) return { rows: [{ workspace_id: '/repo' }] };
      if (/FROM ai_tool_call_file_edits/.test(sql)) return { rows: [] };
      if (/FROM session_files/.test(sql)) return { rows: editedSessionFiles() };
      if (/FROM document_history/.test(sql)) return { rows: preEditRows() };
      return { rows: [] };
    });
  });

  it('resolves diffs with a bounded, per-session query count (no N+1 over tool calls)', async () => {
    const messages = [
      fileChangeMessage('tc-1', 1_000_000_000_100),
      fileChangeMessage('tc-2', 1_000_000_000_200),
      fileChangeMessage('tc-3', 1_000_000_000_300),
    ];

    const enriched = await enrichTranscriptMessagesWithToolCallDiffs(SESSION_ID, messages);

    // Diff output is preserved: every file_change row gets its a.ts diff.
    for (let i = 0; i < 3; i++) {
      const diffs = enriched[i]?.toolCall?.fileDiffs;
      expect(diffs?.[0]?.filePath).toBe('/repo/a.ts');
      expect(diffs?.[0]?.diffs?.[0]?.oldString).toContain('BEFORE');
      expect(diffs?.[0]?.diffs?.[0]?.newString).toContain('AFTER');
    }

    const sqls = dbMock.query.mock.calls.map((c) => String(c[0]));

    // The workspace lookup and the per-file pre-edit snapshot lookup must NOT
    // scale with the number of tool calls. Before batching, each of the 3 tool
    // calls issued its own workspace_id query and its own `LIMIT 1`
    // document_history query -> an N+1. After batching these are loaded once.
    const workspaceQueries = sqls.filter((s) => /workspace_id/.test(s));
    expect(workspaceQueries.length).toBe(1);

    const perCallHistoryQueries = sqls.filter(
      (s) => /FROM document_history/.test(s) && /LIMIT 1/.test(s),
    );
    expect(perCallHistoryQueries.length).toBe(0);

    const historyQueries = sqls.filter((s) => /FROM document_history/.test(s));
    expect(historyQueries.length).toBe(1);

    // On SQLite the pre-edit lookup MUST use json_extract, not metadata->>'x'.
    // The dialect translator parameterizes ->> keys into ->>?, which no
    // expression index (idx_history_preedit_session) can match -> full scan.
    expect(historyQueries[0]).toContain("json_extract(metadata, '$.sessionId')");
    expect(historyQueries[0]).not.toContain("metadata->>'sessionId'");
  });
});
