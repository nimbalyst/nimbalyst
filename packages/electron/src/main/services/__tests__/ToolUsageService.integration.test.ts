import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { ToolUsageService } from '../ToolUsageService';
import type { AppDatabase } from '../../database/PGLiteDatabaseWorker';

/**
 * Exercises the real UPSERT + aggregate read path against a live better-sqlite3
 * backend (migrations applied from the real schema dir, including 0026). This
 * proves the counter write path works without a full app restart -- the
 * failing-first guard for a restart-to-verify DB change.
 */
describe('ToolUsageService (real SQLite backend)', () => {
  let tmpDir: string;
  let sqlite: SQLiteDatabase;
  let service: ToolUsageService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tool-usage-'));
    sqlite = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir: path.resolve(
        __dirname,
        '..',
        '..',
        'database',
        'sqlite',
        'schemas',
      ),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    service = new ToolUsageService(sqlite as unknown as AppDatabase);
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the tool_usage_counters table via migration 0026', async () => {
    const handle = sqlite.getRawHandle()!;
    const cols = handle
      .prepare(`PRAGMA table_info(tool_usage_counters)`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'tool_name',
        'mcp_server',
        'provider',
        'project_path',
        'day',
        'count',
      ]),
    );
  });

  it('UPSERTs and accumulates counts across batches for the same tool/day/project', async () => {
    await service.recordBatch(
      [{ name: 'Read' }, { name: 'Read' }, { name: 'Bash', isError: true }],
      {
        provider: 'claude-code',
        projectPath: '/repo',
        day: '2026-07-21',
      },
    );
    await service.recordBatch([{ name: 'Read' }], {
      provider: 'claude-code',
      projectPath: '/repo',
      day: '2026-07-21',
    });

    const rollup = await service.getRollup();
    expect(rollup['Read'].count).toBe(3);
    expect(rollup['Bash'].count).toBe(1);
  });

  it('rolls MCP tools up to mcp:<server> for tips', async () => {
    await service.recordBatch(
      [
        { name: 'mcp__nimbalyst-excalidraw__excalidraw_add_rectangle' },
        { name: 'mcp__nimbalyst-excalidraw__excalidraw_add_arrow' },
      ],
      { provider: 'claude-code', projectPath: '/repo', day: '2026-07-21' },
    );

    const rollup = await service.getRollup();
    expect(rollup['mcp:nimbalyst-excalidraw'].count).toBe(2);
  });

  it('produces report aggregates (top tools, by kind, by provider)', async () => {
    await service.recordBatch([{ name: 'Read' }, { name: 'Read' }], {
      provider: 'claude-code',
      projectPath: '/repo',
      day: '2026-07-20',
    });
    await service.recordBatch([{ name: 'mcp__nimbalyst__display_chart' }], {
      provider: 'openai-codex',
      projectPath: '/repo',
      day: '2026-07-21',
    });

    const report = await service.getReport();
    expect(report.topTools[0]).toMatchObject({ toolName: 'Read', count: 2 });
    expect(report.byKind).toEqual({ builtin: 2, mcp: 1 });
    expect(report.overTime.map((d) => d.day)).toEqual([
      '2026-07-20',
      '2026-07-21',
    ]);
    const providers = Object.fromEntries(
      report.byProvider.map((p) => [p.provider, p.count]),
    );
    expect(providers['claude-code']).toBe(2);
    expect(providers['openai-codex']).toBe(1);
  });

  it('filters the report by workspace', async () => {
    await service.recordBatch([{ name: 'Read' }], {
      projectPath: '/repo-a',
      day: '2026-07-21',
    });
    await service.recordBatch([{ name: 'Bash' }], {
      projectPath: '/repo-b',
      day: '2026-07-21',
    });

    const report = await service.getReport('/repo-a');
    expect(report.topTools).toHaveLength(1);
    expect(report.topTools[0].toolName).toBe('Read');
  });

  it('computes kind totals from all tools rather than the top-100 result', async () => {
    await service.recordBatch(
      [
        ...Array.from({ length: 101 }, (_, index) => ({
          name: `Builtin${index}`,
        })),
        { name: 'mcp__nimbalyst__display_chart' },
      ],
      { projectPath: '/repo', day: '2026-07-21' },
    );

    const report = await service.getReport();
    expect(report.topTools).toHaveLength(100);
    expect(report.byKind).toEqual({ builtin: 101, mcp: 1 });
  });

  it('backfills persisted Claude and both Codex formats once even when live counters exist', async () => {
    const handle = sqlite.getRawHandle()!;
    const insertSession = handle.prepare(
      `INSERT INTO ai_sessions (id, workspace_id, provider, title)
       VALUES (?, ?, ?, ?)`,
    );
    insertSession.run('codex-session', '/repo', 'openai-codex', 'Codex');
    insertSession.run('claude-session', '/repo', 'claude-code', 'Claude');

    const insertMessage = handle.prepare(
      `INSERT INTO ai_agent_messages (session_id, source, direction, content, created_at)
       VALUES (?, ?, 'output', ?, ?)`,
    );
    const createdAt = '2026-01-02T03:04:05.000Z';
    insertMessage.run(
      'codex-session',
      'openai-codex',
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'function_call',
          id: 'item_0',
          name: 'Read',
          status: 'completed',
        },
      }),
      createdAt,
    );
    insertMessage.run(
      'codex-session',
      'openai-codex',
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'function_call',
          id: 'item_0',
          name: 'Read',
          status: 'completed',
        },
      }),
      createdAt,
    );
    insertMessage.run(
      'codex-session',
      'openai-codex',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'item_1', exit_code: 0 },
      }),
      createdAt,
    );
    insertMessage.run(
      'codex-session',
      'openai-codex',
      JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'call-1',
            server: 'nimbalyst',
            tool: 'update_session_meta',
            status: 'completed',
          },
        },
      }),
      createdAt,
    );
    const claudeToolUse = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }],
      },
    });
    insertMessage.run(
      'claude-session',
      'claude-code',
      claudeToolUse,
      createdAt,
    );
    insertMessage.run(
      'claude-session',
      'claude-code',
      claudeToolUse,
      createdAt,
    );

    await service.recordBatch([{ name: 'LiveOnly' }], {
      provider: 'claude-code',
      projectPath: '/repo',
      day: '2026-07-21',
    });

    const first = await service.backfillFromRawMessages();
    expect(first).toEqual({ sessionsProcessed: 2, toolCallsCounted: 5 });
    const rollup = await service.getRollup();
    expect(rollup.Read.count).toBe(2);
    expect(rollup.command_execution.count).toBe(1);
    expect(rollup['mcp:nimbalyst'].count).toBe(1);
    expect(rollup.Edit.count).toBe(1);
    expect(rollup.LiveOnly.count).toBe(1);

    const second = await service.backfillFromRawMessages();
    expect(second).toEqual({ sessionsProcessed: 0, toolCallsCounted: 0 });
    expect((await service.getRollup()).Read.count).toBe(2);
  });
});
