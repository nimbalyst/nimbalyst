import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('jotai-family', () => ({ atomFamily: vi.fn() }));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    initialize: vi.fn(),
    query: vi.fn(),
    getEngine: vi.fn(() => 'pglite'),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

const mockGetMultiSessionEvents = vi.fn();
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({
  TranscriptMigrationRepository: {
    hasService: () => false,
    getService: () => ({
      findToolCallByProviderId: vi.fn().mockResolvedValue(null),
      getMultiSessionEvents: mockGetMultiSessionEvents,
    }),
  },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import { database } from '../../database/PGLiteDatabaseWorker';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { logger } from '../../utils/logger';
import { createPGLiteSessionFileStore } from '../PGLiteSessionFileStore';
import { parseToolCallWindows, scoreMatch, scoreWorkspaceFileEdit, toolCallMatcher, type ToolCallWindow } from '../ToolCallMatcher';

describe('ToolCallMatcher', () => {
  beforeEach(() => {
    (database.query as ReturnType<typeof vi.fn>).mockReset();
    mockGetMultiSessionEvents.mockReset();
  });

  describe('parseToolCallWindows', () => {
    const baseDate = new Date('2026-02-20T12:00:00Z');
    const SESSION_ID = 'test-session';

    it('should parse Write tool call with file_path argument', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'tool-123',
          server: 'nimbalyst',
          tool: 'Write',
          arguments: { file_path: '/workspace/src/index.ts' },
          result: { success: true },
        },
      });

      const windows = parseToolCallWindows(1, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('mcp__nimbalyst__Write');
      expect(windows[0].toolCallItemId).toBe('tool-123');
      expect(windows[0].argsText).toContain('index.ts');
      expect(windows[0].messageId).toBe(1);
    });

    it('should parse Edit tool call with filePath argument', () => {
      const content = JSON.stringify({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'tool-456',
          server: 'nimbalyst',
          tool: 'Edit',
          arguments: { filePath: '/workspace/src/app.tsx' },
        },
      });

      const windows = parseToolCallWindows(2, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('app.tsx');
    });

    it('should parse command_execution (Bash) tool call', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-789',
          command: 'printf "hello" > /workspace/output.txt',
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(3, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Bash');
      expect(windows[0].argsText).toContain('output.txt');
    });

    it('should parse file_change event with multiple files', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc-001',
          changes: [
            { path: '/workspace/src/a.ts', kind: 'edit' },
            { path: '/workspace/src/b.ts', kind: 'create' },
          ],
          result: { status: 'completed' },
        },
      });

      const windows = parseToolCallWindows(4, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('file_change');
      expect(windows[0].argsText).toContain('a.ts');
      expect(windows[0].argsText).toContain('b.ts');
    });

    it('should prefer synthetic Codex editGroupId from raw message metadata', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'item_3',
          changes: [
            { path: '/workspace/src/a.ts', kind: 'update' },
          ],
        },
      });

      const windows = parseToolCallWindows(
        12,
        content,
        baseDate,
        SESSION_ID,
        '/workspace',
        { editGroupId: 'nimtc|item_3|1700000000000|9' },
      );

      expect(windows).toHaveLength(1);
      expect(windows[0].toolCallItemId).toBe('item_3');
      expect(windows[0].toolUseId).toBe('nimtc|item_3|1700000000000|9');
    });

    it('should ignore non-synthetic editGroupId metadata', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'item_7',
          changes: [
            { path: '/workspace/src/a.ts', kind: 'update' },
          ],
        },
      });

      const windows = parseToolCallWindows(
        13,
        content,
        baseDate,
        SESSION_ID,
        '/workspace',
        { editGroupId: 'item_7' },
      );

      expect(windows).toHaveLength(1);
      expect(windows[0].toolUseId).toBe('item_7');
    });

    it('should include output text from tool results', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-out',
          command: 'node build.js',
          aggregated_output: 'Written output to /workspace/dist/bundle.js successfully',
        },
      });

      const windows = parseToolCallWindows(5, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].outputText).toContain('bundle.js');
    });

    it('should return empty array for non-tool events', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'message',
          content: 'Hello world',
        },
      });

      const windows = parseToolCallWindows(6, content, baseDate, SESSION_ID);

      expect(windows).toHaveLength(0);
    });

    it('should return empty array for invalid JSON', () => {
      const windows = parseToolCallWindows(7, 'not json', baseDate, SESSION_ID);
      expect(windows).toHaveLength(0);
    });

    it('should return empty array for text-only chunks', () => {
      const content = JSON.stringify({ type: 'text', content: 'Some text' });
      const windows = parseToolCallWindows(8, content, baseDate, SESSION_ID);
      expect(windows).toHaveLength(0);
    });

    it('should include bash command in argsText for sed -i', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-sed',
          command: "sed -i 's/foo/bar/' /workspace/config.json",
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(9, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('config.json');
    });

    it('should include bash command in argsText for tee', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-tee',
          command: 'echo "data" | tee /workspace/log.txt',
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(10, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('log.txt');
    });

    it('should include bash command in argsText for chained commands', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-chain',
          command: 'mkdir -p /workspace/out && cp /workspace/src/a.ts /workspace/out/a.ts',
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(11, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('a.ts');
    });

    // ---------------------------------------------------------------
    // Raw Claude API format tests
    // ---------------------------------------------------------------

    it('should parse raw Claude API format with tool_use blocks', () => {
      const content = JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          id: 'msg_01ABC',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01XYZ',
              name: 'Edit',
              input: {
                file_path: '/workspace/src/app.ts',
                old_string: 'foo',
                new_string: 'bar',
              },
            },
          ],
        },
      });

      const windows = parseToolCallWindows(20, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Edit');
      expect(windows[0].toolCallItemId).toBe('toolu_01XYZ');
      expect(windows[0].toolUseId).toBe('toolu_01XYZ');
      expect(windows[0].argsText).toContain('app.ts');
    });

    it('should parse raw Claude API format with multiple tool_use blocks', () => {
      const content = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01AAA',
              name: 'Write',
              input: { file_path: '/workspace/a.ts', content: 'hello' },
            },
            {
              type: 'tool_use',
              id: 'toolu_01BBB',
              name: 'Write',
              input: { file_path: '/workspace/b.ts', content: 'world' },
            },
          ],
        },
      });

      const windows = parseToolCallWindows(21, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(2);
      expect(windows[0].toolCallItemId).toBe('toolu_01AAA');
      expect(windows[0].argsText).toContain('a.ts');
      expect(windows[1].toolCallItemId).toBe('toolu_01BBB');
      expect(windows[1].argsText).toContain('b.ts');
    });

    it('should ignore text blocks in raw Claude API format', () => {
      const content = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me edit the file.' },
            {
              type: 'tool_use',
              id: 'toolu_01CCC',
              name: 'Edit',
              input: { file_path: '/workspace/c.ts', old_string: 'x', new_string: 'y' },
            },
          ],
        },
      });

      const windows = parseToolCallWindows(22, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Edit');
    });

    it('should return empty for raw Claude API user messages with tool_result', () => {
      const content = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'toolu_01XYZ',
              type: 'tool_result',
              content: 'File edited successfully',
            },
          ],
        },
      });

      const windows = parseToolCallWindows(23, content, baseDate, SESSION_ID, '/workspace');

      // tool_result blocks don't have 'name' so they should be skipped
      expect(windows).toHaveLength(0);
    });

    it('should extract tool use id from item', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'toolu_abc123',
          tool_use_id: 'toolu_abc123',
          server: 'test',
          tool: 'Write',
          arguments: { file_path: '/workspace/file.ts' },
        },
      });

      const windows = parseToolCallWindows(13, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolUseId).toBe('toolu_abc123');
      expect(windows[0].toolCallItemId).toBe('toolu_abc123');
    });
  });

  describe('scoreMatch', () => {
    const baseTime = new Date('2026-02-20T12:00:00Z').getTime();

    function makeWindow(overrides: Partial<ToolCallWindow> = {}): ToolCallWindow {
      return {
        messageId: 1,
        messageCreatedAt: baseTime,
        sessionId: 'test-session',
        toolName: 'Edit',
        toolCallItemId: 'tool-1',
        toolUseId: 'toolu_1',
        argsText: '',
        outputText: '',
        ...overrides,
      };
    }

    it('should return null when file timestamp is outside 10s cutoff', () => {
      const window = makeWindow({ argsText: '{"file_path":"/workspace/src/app.ts"}' });
      // 15 seconds after tool call
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 15_000, window);
      expect(result).toBeNull();
    });

    it('should return null when file timestamp is far before tool call', () => {
      const window = makeWindow({ argsText: '{"file_path":"/workspace/src/app.ts"}' });
      // 15 seconds before tool call
      const result = scoreMatch('/workspace/src/app.ts', baseTime - 15_000, window);
      expect(result).toBeNull();
    });

    it('should match by filename in argsText', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/different/workspace/src/app.ts"}',
      });
      // Within time window
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(40);
      expect(result!.reasons).toContain('name_in_args');
    });

    it('should match filename in output text', () => {
      const window = makeWindow({
        outputText: 'Successfully wrote to app.ts',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(30);
      expect(result!.reasons).toContain('name_in_output');
    });

    it('should combine name_in_args and name_in_output scores', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/app.ts"}',
        outputText: 'Wrote app.ts successfully',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(70); // 40 + 30
    });

    it('should bypass time cutoff for toolUseId match', () => {
      const window = makeWindow({ toolUseId: 'toolu_exact' });
      // 30 seconds away - way outside the 10s cutoff
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 30_000, window, 'toolu_exact');
      expect(result).not.toBeNull();
      expect(result!.score).toBe(100);
      expect(result!.reasons).toContain('toolUseId');
    });

    it('should return score 0 (below threshold) when within time but no name match', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/other.ts"}',
        outputText: 'no relevant paths here',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });

    it('should match at exactly 10s boundary', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/app.ts"}',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 10_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(40);
    });

    it('should reject at just over 10s boundary', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/app.ts"}',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 10_001, window);
      expect(result).toBeNull();
    });

    it('should match file_change by path_in_changes without toolUseId (Codex sessions)', () => {
      // For Codex sessions, toolUseId is not stored in session_files metadata.
      // Matching relies on filename/path heuristics within the time window.
      const fileChangeWindow = makeWindow({
        messageId: 200,
        toolName: 'file_change',
        toolCallItemId: 'item_53',
        toolUseId: 'item_53',
        argsText: '{"changes":[{"path":"/workspace/src/app.ts","kind":"update"}]}',
        args: { changes: [{ path: '/workspace/src/app.ts', kind: 'update' }] },
      });

      // No fileMetadataToolUseId passed — simulates Codex session where we don't store item IDs
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, fileChangeWindow);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(40); // path_in_changes
      expect(result!.reasons).toContain('path_in_changes');
    });

    it('should not match Codex reused item IDs when toolUseId not in session_files', () => {
      // Codex reuses item IDs across turns. When we don't store toolUseId in
      // session_files metadata, the toolUseId shortcut path is never triggered,
      // so matching falls through to time+filename heuristics.
      const bashWindow = makeWindow({
        messageId: 100,
        toolName: 'Bash',
        toolCallItemId: 'item_53',
        toolUseId: 'item_53',
        argsText: '{"command":"grep -Rns logAgentMessage"}',
      });

      // No fileMetadataToolUseId — toolUseId match path won't fire.
      // File is within time window but filename not in args → no match.
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, bashWindow);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0); // No filename match
    });
  });

  // ---------------------------------------------------------------------------
  // Real Codex event fixtures (from session fb958ac8-ce5d-4605-8756-2861ed0c095f)
  // ---------------------------------------------------------------------------

  describe('Codex real event fixtures', () => {
    const baseDate = new Date('2026-02-21T01:55:59Z');
    const SESSION_ID = 'fb958ac8-ce5d-4605-8756-2861ed0c095f';
    const WORKSPACE = '/Users/jordanbentley/git/nimnim_worktrees/noble-owl';

    it('should parse file_change event from Codex apply_diff', () => {
      // Real message 329861 from the Codex session
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_9',
          type: 'file_change',
          changes: [
            { path: '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt', kind: 'update' },
          ],
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(329861, content, baseDate, SESSION_ID, WORKSPACE);

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('file_change');
      expect(windows[0].argsText).toContain('hello.txt');
    });

    it('should parse command_execution bash redirect from Codex', () => {
      // Real message 329867 from the Codex session - bash append via >>
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_13',
          type: 'command_execution',
          command: '/bin/zsh -lc "printf \'%s\\n\' \\"Bash edit: appended line on 2026-02-21.\\" >> test/second-file.txt"',
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(329867, content, baseDate, SESSION_ID, WORKSPACE);

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Bash');
      // After unwrapping /bin/zsh -lc wrapper, the command should be in argsText
      expect(windows[0].argsText).toContain('second-file.txt');
    });

    it('should unwrap /bin/zsh -lc wrapper to extract inner command', () => {
      // Simpler case: zsh wrapping a redirect
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'cmd-zsh',
          type: 'command_execution',
          command: "/bin/zsh -lc 'echo hello > /workspace/output.txt'",
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(1, content, new Date(), 'test', '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('output.txt');
    });

    it('should match file_change edit to tool call with consistent timestamps', () => {
      const toolTime = new Date('2026-02-21T01:55:59.477Z').getTime();
      const fileTime = new Date('2026-02-21T01:55:59.481Z').getTime(); // 4ms later (same timezone)

      const window: ToolCallWindow = {
        messageId: 329861,
        messageCreatedAt: toolTime,
        sessionId: SESSION_ID,
        toolName: 'file_change',
        toolCallItemId: 'item_9',
        toolUseId: 'item_9',
        argsText: '{"changes":[{"path":"/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt","kind":"update"}]}',
        outputText: '',
        args: { changes: [{ path: '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt', kind: 'update' }] },
      };

      const result = scoreMatch(
        '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt',
        fileTime,
        window
      );

      expect(result).not.toBeNull();
      expect(result!.score).toBe(40); // path_in_changes
      expect(result!.reasons).toContain('path_in_changes');
    });

    it('should NOT match when timestamps have timezone mismatch (Bug 3)', () => {
      // This demonstrates Bug 3: 5-hour offset kills matching
      const toolTimeUtc = new Date('2026-02-21T01:55:59.477Z').getTime();
      const fileTimeLocal = new Date('2026-02-21T06:55:59.481Z').getTime(); // 5h offset

      const window: ToolCallWindow = {
        messageId: 329861,
        messageCreatedAt: toolTimeUtc,
        sessionId: SESSION_ID,
        toolName: 'file_change',
        toolCallItemId: 'item_9',
        toolUseId: null,
        argsText: '{"changes":[{"path":"/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt","kind":"update"}]}',
        outputText: '',
        args: { changes: [{ path: '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt', kind: 'update' }] },
      };

      const result = scoreMatch(
        '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt',
        fileTimeLocal,
        window
      );

      // With 5h offset, this falls outside the 10s cutoff
      expect(result).toBeNull();
    });

    it('should parse command_execution without /bin/zsh wrapper', () => {
      // Some Codex commands don't have shell wrappers
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'cmd-direct',
          type: 'command_execution',
          command: 'echo "test" > /workspace/direct.txt',
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(1, content, new Date(), 'test', '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('direct.txt');
    });
  });

  describe('extractDiffsFromMessageContent', () => {
    // Access private method for targeted testing
    const extract = (content: string, targetFilePath: string) =>
      (toolCallMatcher as any).extractDiffsFromMessageContent(content, targetFilePath);

    it('should not early-return for file_change items with no arguments but with changes content', () => {
      // file_change items from Codex have no arguments/args/input/parameters,
      // which previously caused an early return at the `if (!args)` guard
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc_123',
          changes: [
            { path: '/workspace/src/app.ts', kind: 'update', content: 'const x = 1;\n' },
          ],
        },
      });

      const result = extract(content, '/workspace/src/app.ts');
      expect(result.content).toBe('const x = 1;\n');
      expect(result.diffs).toEqual([]);
    });

    it('should return empty diffs for file_change with changes but no content field', () => {
      // Typical Codex file_change: has changes array but no content on each change
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc_456',
          changes: [
            { path: '/workspace/src/app.ts', kind: 'update' },
          ],
        },
      });

      const result = extract(content, '/workspace/src/app.ts');
      expect(result.diffs).toEqual([]);
    });

    it('should return empty diffs for file_change targeting a different file', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc_789',
          changes: [
            { path: '/workspace/src/other.ts', kind: 'update', content: 'other content' },
          ],
        },
      });

      const result = extract(content, '/workspace/src/app.ts');
      expect(result.diffs).toEqual([]);
    });
  });

  describe('workspace-scoped attribution', () => {
    const baseTime = new Date('2026-02-21T01:55:59.477Z').getTime();

    it('scores Bash command text evidence without Bash file-op parsing', () => {
      const window: ToolCallWindow = {
        messageId: 101,
        messageCreatedAt: baseTime,
        sessionId: 'session-bash',
        toolName: 'Bash',
        toolCallItemId: 'item-bash',
        toolUseId: 'item-bash',
        argsText: "{\"command\":\"sed -i 's/foo/bar/' /workspace/src/config.ts\"}",
        outputText: '',
        args: { command: "sed -i 's/foo/bar/' /workspace/src/config.ts" },
      };

      const scored = scoreWorkspaceFileEdit('/workspace/src/config.ts', baseTime + 100, window);
      expect(scored).not.toBeNull();
      expect(scored!.reasons).toContain('bash_command_path_text');
      expect(scored!.score).toBeGreaterThanOrEqual(50);
    });

    it('selects a clear winner across candidate sessions', async () => {
      // Mock database.query for getRawToolCallWindowsMultiSession
      // which queries ai_agent_messages directly
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            session_id: 'session-1',
            id: 1,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'file_change',
                id: 'item-fc-1',
                changes: [{ path: '/workspace/src/a.ts', kind: 'update' }],
              },
            }),
            created_at_ms: baseTime,
          },
          {
            session_id: 'session-2',
            id: 2,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'command_execution',
                id: 'item-bash-2',
                command: 'echo test >> a.ts',
              },
            }),
            created_at_ms: baseTime + 50,
          },
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/a.ts',
        fileTimestamp: baseTime + 70,
        candidateSessionIds: ['session-1', 'session-2'],
      });

      expect(result.reason).toBe('winner_selected');
      expect(result.winner?.sessionId).toBe('session-1');
      expect(result.candidates.length).toBe(2);
    });

    it('returns no winner when top candidate scores are tied', async () => {
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            session_id: 'session-a',
            id: 11,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'file_change',
                id: 'item-a',
                changes: [{ path: '/workspace/src/shared.ts', kind: 'update' }],
              },
            }),
            created_at_ms: baseTime,
          },
          {
            session_id: 'session-b',
            id: 12,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'file_change',
                id: 'item-b',
                changes: [{ path: '/workspace/src/shared.ts', kind: 'update' }],
              },
            }),
            created_at_ms: baseTime,
          },
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/shared.ts',
        fileTimestamp: baseTime + 50,
        candidateSessionIds: ['session-a', 'session-b'],
      });

      expect(result.winner).toBeNull();
      expect(result.reason).toBe('ambiguous');
      expect(result.candidates.length).toBe(2);
    });

    it('does not let a command that names the file beat another session running an unnamed writer', async () => {
      const assistantToolUse = (sessionId: string, id: number, toolUseId: string, command: string) => ({
        session_id: sessionId,
        id,
        content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }] },
        }),
        created_at_ms: baseTime,
      });
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          assistantToolUse('reader', 21, 'toolu_reader', 'cat /workspace/src/generated.ts'),
          assistantToolUse('writer', 22, 'toolu_writer', 'node scripts/generate.js'),
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/generated.ts',
        fileTimestamp: baseTime + 100,
        candidateSessionIds: ['reader', 'writer'],
      });

      expect(result.winner).toBeNull();
      expect(result.reason).toBe('competing_writer');
    });

    // A hook-window session owns its Bash edits through its own tracker. When
    // its tool is the best explanation, no lower-scored session may take it.
    it('gives no winner when the best match belongs to an ineligible hook-window session', async () => {
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            session_id: 'claude-shell', id: 31, created_at_ms: baseTime,
            content: JSON.stringify({ type: 'item.completed', item: { type: 'file_change', id: 'item-c', changes: [{ path: '/workspace/src/c.ts', kind: 'update' }] } }),
          },
          {
            session_id: 'opencode', id: 32, created_at_ms: baseTime + 50,
            content: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'item-o', command: 'echo test >> c.ts' } }),
          },
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/c.ts',
        fileTimestamp: baseTime + 70,
        candidateSessionIds: ['claude-shell', 'opencode'],
        ineligibleSessionIds: ['claude-shell'],
      });

      expect(result.winner).toBeNull();
      expect(result.reason).toBe('shell_window_owner');
    });
  });

  describe('getDiffsForToolCall (Codex synthetic ID lookup)', () => {
    it('queries session_files using both the synthetic and raw lookup forms', async () => {
      const SESSION_ID = 'codex-session';
      const SYNTHETIC = 'nimtc|item_0|1700000000000|7';
      const RAW = 'item_0';

      const queryMock = database.query as ReturnType<typeof vi.fn>;

      // First call: workspace_id lookup inside getDiffsFromToolCallContent.
      queryMock.mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain('workspace_id');
        expect(sql).toContain('FROM ai_sessions');
        return { rows: [{ workspace_id: '/ws' }] };
      });

      // Second call: session_files lookup. The new code uses ANY($2) with both
      // synthetic (primary) and raw (fallback) forms so legacy data still
      // resolves while new data also resolves.
      queryMock.mockImplementationOnce(async (sql: string, params: unknown[]) => {
        expect(sql).toContain('FROM session_files');
        expect(sql).toContain("metadata->>'toolUseId' = ANY($2)");
        const lookupIds = params[1] as string[];
        expect(lookupIds).toContain(SYNTHETIC);
        expect(lookupIds).toContain(RAW);
        return { rows: [] }; // empty so the function returns [] early
      });

      const diffs = await toolCallMatcher.getDiffsForToolCall(
        SESSION_ID,
        SYNTHETIC,
      );
      expect(diffs).toEqual([]);
    });

    it('passes a single id when synthetic and raw collapse to the same value', async () => {
      const SESSION_ID = 'claude-session';
      const RAW = 'toolu_abc'; // not a synthetic ID

      const queryMock = database.query as ReturnType<typeof vi.fn>;

      // workspace_id lookup
      queryMock.mockImplementationOnce(async () => ({ rows: [{ workspace_id: '/ws' }] }));
      // session_files lookup -- both forms equal, expect single-element ANY array
      queryMock.mockImplementationOnce(async (_sql: string, params: unknown[]) => {
        const lookupIds = params[1] as string[];
        expect(lookupIds).toEqual([RAW]);
        return { rows: [] };
      });

      const diffs = await toolCallMatcher.getDiffsForToolCall(SESSION_ID, RAW);
      expect(diffs).toEqual([]);
    });
  });

  describe('matchSession raw-message bounds', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;

    /**
     * Dispatch by SQL, and assert AFTER matchSession returns.
     *
     * These used to chain mockImplementationOnce with the expectations inside
     * the mock bodies. matchSession wraps everything in try/catch, so when the
     * query ORDER changed the expect() threw, got swallowed, and the tests
     * still passed on the fallback `return 0` — green while testing nothing.
     * Capture here, assert outside.
     */
    function stubSession(opts: {
      files: Array<Record<string, unknown>>;
      messages?: Array<Record<string, unknown>>;
      existingMatches?: Array<{ session_file_id: string; match_score: number; tool_use_id: string | null }>;
    }) {
      const captured: {
        messagesSql?: string;
        messagesParams?: unknown[];
        insertParams?: unknown[];
        sawMessagesQuery: boolean;
      } = { sawMessagesQuery: false };

      queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM ai_sessions')) return { rows: [{ workspace_id: '/workspace' }] };
        if (sql.includes('FROM session_files')) return { rows: opts.files };
        if (sql.includes('FROM ai_tool_call_file_edits')) return { rows: opts.existingMatches ?? [] };
        if (sql.includes('FROM ai_agent_messages')) {
          captured.sawMessagesQuery = true;
          captured.messagesSql = sql;
          captured.messagesParams = params;
          return { rows: opts.messages ?? [] };
        }
        if (/^\s*INSERT/i.test(sql)) captured.insertParams = params;
        return { rows: [] };
      });

      return captured;
    }

    const BOUND_LOWER = '(EXTRACT(EPOCH FROM created_at) * 1000) >= $2';
    const BOUND_UPPER = '(EXTRACT(EPOCH FROM created_at) * 1000) <= $3';

    it('bounds sessions without definitive tool IDs to the editable file window', async () => {
      const sessionId = 'bounded-session';
      const earliestTimestamp = 1_700_000_000_000;
      const latestTimestamp = earliestTimestamp + 45_000;

      const captured = stubSession({
        files: [
          { id: 'early-file', file_path: '/workspace/src/early.ts', timestamp_ms: earliestTimestamp, metadata: {} },
          { id: 'late-file', file_path: '/workspace/src/late.ts', timestamp_ms: latestTimestamp, metadata: {} },
        ],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(0);

      expect(captured.sawMessagesQuery).toBe(true);
      expect(captured.messagesSql).toContain(BOUND_LOWER);
      expect(captured.messagesSql).toContain(BOUND_UPPER);
      expect(captured.messagesParams).toEqual([
        sessionId,
        earliestTimestamp - 10_000,
        latestTimestamp + 10_000,
      ]);
    });

    // PGLite hands session_files.metadata back as an object, SQLite as JSON text.
    it.each([
      ['object (PGLite)', { toolUseId: 'tool-definitive' }],
      ['JSON string (SQLite)', JSON.stringify({ toolUseId: 'tool-definitive' })],
    ])('preserves out-of-window exact toolUseId matches with an unbounded lookup, metadata as %s', async (_shape, metadata) => {
      const sessionId = 'definitive-id-session';
      const fileTimestamp = 1_700_000_000_000;
      const toolTimestamp = fileTimestamp - 60_000;

      const captured = stubSession({
        files: [{
          id: 'file-1',
          file_path: '/workspace/src/kept.ts',
          timestamp_ms: fileTimestamp,
          metadata,
        }],
        messages: [{
          id: 42,
          created_at_ms: toolTimestamp,
          metadata: {},
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [{
                type: 'tool_use',
                id: 'tool-definitive',
                name: 'Edit',
                input: { file_path: '/workspace/src/kept.ts' },
              }],
            },
          }),
        }],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(1);

      // The tool call is 60s before the edit — far outside TIME_CUTOFF_MS — so
      // it is only reachable because the lookup stayed unbounded.
      expect(captured.messagesSql).not.toContain(BOUND_LOWER);
      expect(captured.messagesSql).not.toContain(BOUND_UPPER);
      expect(captured.messagesParams).toEqual([sessionId]);
      expect(captured.insertParams).toEqual(expect.arrayContaining([
        sessionId,
        'file-1',
        42,
        'tool-definitive',
        100,
      ]));
    });

    it('B1: bounds a Codex edit-group id to the edit window and still scores the window that carries it 100', async () => {
      const sessionId = 'minted-id-session';
      const fileTimestamp = 1_700_000_000_000;
      const editGroupId = 'nimtc|item_3|1700000000000|9';

      const captured = stubSession({
        files: [{ id: 'file-codex', file_path: '/workspace/src/a.ts', timestamp_ms: fileTimestamp, metadata: { toolUseId: editGroupId } }],
        messages: [{
          id: 12,
          created_at_ms: fileTimestamp - 1_000,
          metadata: { editGroupId },
          content: JSON.stringify({
            type: 'item.completed',
            item: { type: 'file_change', id: 'item_3', changes: [{ path: '/workspace/src/a.ts', kind: 'update' }] },
          }),
        }],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(1);

      expect(captured.messagesParams).toEqual([sessionId, fileTimestamp - 10_000, fileTimestamp + 10_000]);
      expect(captured.insertParams).toEqual(expect.arrayContaining([sessionId, 'file-codex', 12, editGroupId, 100]));
    });

    it('falls back to an unbounded lookup when a stored file timestamp is invalid', async () => {
      const sessionId = 'invalid-timestamp-session';

      const captured = stubSession({
        files: [{
          id: 'file-invalid',
          file_path: '/workspace/src/invalid.ts',
          timestamp_ms: 'not-a-number',
          metadata: {},
        }],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(0);

      expect(captured.sawMessagesQuery).toBe(true);
      expect(captured.messagesSql).not.toContain(BOUND_LOWER);
      expect(captured.messagesSql).not.toContain(BOUND_UPPER);
      expect(captured.messagesParams).toEqual([sessionId]);
    });
  });

  describe('matchSession incremental work (NIM-3085)', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;

    /**
     * Dispatch by SQL rather than call order — this suite is about WHICH
     * queries run, so pinning an order would obscure the thing under test.
     */
    function stubQueries(opts: {
      files: Array<{ id: string; file_path: string; timestamp_ms: number; metadata: any }>;
      existingMatches: Array<{ session_file_id: string; match_score: number; tool_use_id: string | null }>;
    }) {
      const seen: string[] = [];
      queryMock.mockImplementation(async (sql: string) => {
        seen.push(sql);
        if (sql.includes('FROM ai_sessions')) return { rows: [{ workspace_id: '/workspace' }] };
        if (sql.includes('FROM session_files')) return { rows: opts.files };
        if (sql.includes('FROM ai_tool_call_file_edits')) return { rows: opts.existingMatches };
        if (sql.includes('FROM ai_agent_messages')) return { rows: [] };
        return { rows: [] };
      });
      return { seen, scannedMessages: () => seen.some(s => s.includes('FROM ai_agent_messages')) };
    }

    it('skips the transcript scan when every file already has a definitive match', async () => {
      // score 100 == exact toolUseId match, the ceiling scoreMatch can return.
      // Re-scoring these can never change the outcome, so the expensive
      // unbounded ai_agent_messages scan is pure waste.
      const probe = stubQueries({
        files: [
          { id: 'f1', file_path: '/workspace/a.ts', timestamp_ms: 1_700_000_000_000, metadata: { toolUseId: 't1' } },
          { id: 'f2', file_path: '/workspace/b.ts', timestamp_ms: 1_700_000_001_000, metadata: { toolUseId: 't2' } },
        ],
        existingMatches: [
          { session_file_id: 'f1', match_score: 100, tool_use_id: 't1' },
          { session_file_id: 'f2', match_score: 100, tool_use_id: 't2' },
        ],
      });

      await expect(toolCallMatcher.matchSession('settled-session')).resolves.toBe(0);

      expect(probe.scannedMessages()).toBe(false);
    });

    it('still scans when at least one file is unmatched', async () => {
      const probe = stubQueries({
        files: [
          { id: 'f1', file_path: '/workspace/a.ts', timestamp_ms: 1_700_000_000_000, metadata: { toolUseId: 't1' } },
          { id: 'f2', file_path: '/workspace/b.ts', timestamp_ms: 1_700_000_001_000, metadata: { toolUseId: 't2' } },
        ],
        existingMatches: [{ session_file_id: 'f1', match_score: 100, tool_use_id: 't1' }],
      });

      await toolCallMatcher.matchSession('partial-session');

      expect(probe.scannedMessages()).toBe(true);
    });

    it('still scans a file whose existing match is below the ceiling (replaceable)', async () => {
      // A 70-score heuristic match CAN be beaten by a later exact-id match,
      // so these files must stay in the candidate set.
      const probe = stubQueries({
        files: [
          { id: 'f1', file_path: '/workspace/a.ts', timestamp_ms: 1_700_000_000_000, metadata: { toolUseId: 't1' } },
        ],
        existingMatches: [{ session_file_id: 'f1', match_score: 70, tool_use_id: null }],
      });

      await toolCallMatcher.matchSession('improvable-session');

      expect(probe.scannedMessages()).toBe(true);
    });
  });

  // SQLite stores session_files.metadata as TEXT and hands it back unparsed;
  // PGLite hands back an object. matchSession has to read both the same way.
  describe('matchSession session_files metadata on both backends', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;
    const T0 = 1_700_000_000_000;
    const asSQLite = (metadata: Record<string, unknown>) => JSON.stringify(metadata);

    type FileRow = { id: string; file_path: string; timestamp_ms: number; metadata: unknown };
    type MessageRow = { id: number; created_at_ms: number; metadata: null; content: string };

    function toolUseMessage(id: number, createdAtMs: number, toolUseId: string, filePath: string): MessageRow {
      return {
        id,
        created_at_ms: createdAtMs,
        metadata: null,
        content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Edit', input: { file_path: filePath } }] },
        }),
      };
    }

    function textMessage(id: number, createdAtMs: number): MessageRow {
      return {
        id,
        created_at_ms: createdAtMs,
        metadata: null,
        content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
      };
    }

    /**
     * Stateful SQL-dispatch fake. Matches one pass writes are read back by the
     * next pass, session_files deletes take effect, and the raw-message read
     * honours the optional created_at bounds ($2/$3) so each scan's work can be
     * counted.
     */
    function fakeSessionDb(files: FileRow[], messages: MessageRow[]) {
      const matches: Array<{ session_file_id: string; message_id: number; tool_use_id: string | null; match_score: number }> = [];
      const stats = { scans: 0, boundedScans: 0, rowsScanned: 0, deletedFileIds: [] as string[] };
      queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/^\s*DELETE FROM session_files/i.test(sql)) {
          const ids = params[0] as string[];
          stats.deletedFileIds.push(...ids);
          for (const id of ids) {
            const index = files.findIndex(f => f.id === id);
            if (index >= 0) files.splice(index, 1);
          }
          return { rows: [] };
        }
        if (/^\s*DELETE FROM ai_tool_call_file_edits/i.test(sql)) {
          const ids = new Set(params[1] as string[]);
          for (let i = matches.length - 1; i >= 0; i--) if (ids.has(matches[i].session_file_id)) matches.splice(i, 1);
          return { rows: [] };
        }
        if (/^\s*INSERT INTO ai_tool_call_file_edits/i.test(sql)) {
          for (let i = 0; i < params.length; i += 8) {
            const [, sessionFileId, messageId, , toolUseId, score] = params.slice(i, i + 8) as [string, string, number, unknown, string | null, number];
            const existing = matches.find(m => m.session_file_id === sessionFileId && m.message_id === messageId);
            if (existing) existing.match_score = score;
            else matches.push({ session_file_id: sessionFileId, message_id: messageId, tool_use_id: toolUseId, match_score: score });
          }
          return { rows: [] };
        }
        if (sql.includes('FROM ai_sessions')) return { rows: [{ workspace_id: '/workspace' }] };
        if (sql.includes('FROM session_files')) return { rows: files.map(f => ({ ...f })) };
        if (sql.includes('FROM ai_tool_call_file_edits')) return { rows: matches.map(m => ({ ...m })) };
        if (sql.includes('FROM ai_agent_messages')) {
          const bounded = params.length >= 3;
          const rows = bounded
            ? messages.filter(m => m.created_at_ms >= (params[1] as number) && m.created_at_ms <= (params[2] as number))
            : messages;
          stats.scans++;
          if (bounded) stats.boundedScans++;
          stats.rowsScanned += rows.length;
          return { rows };
        }
        return { rows: [] };
      });
      return { matches, stats };
    }

    beforeEach(() => {
      vi.mocked(logger.main.error).mockClear();
    });

    it('settles a file whose JSON-string metadata carries its toolUseId, so the next pass skips the scan', async () => {
      // The tool call names the file 2s before the edit, so without the id the
      // best the heuristics reach is 40 (name_in_args): never settled, and
      // every later pass rescans.
      const { matches, stats } = fakeSessionDb(
        [{ id: 'f1', file_path: '/workspace/src/a.ts', timestamp_ms: T0, metadata: asSQLite({ toolUseId: 't1' }) }],
        [toolUseMessage(7, T0 - 2_000, 't1', '/workspace/src/a.ts')],
      );

      await expect(toolCallMatcher.matchSession('sqlite-settle')).resolves.toBe(1);
      await expect(toolCallMatcher.matchSession('sqlite-settle')).resolves.toBe(0);

      expect(matches).toEqual([{ session_file_id: 'f1', message_id: 7, tool_use_id: 't1', match_score: 100 }]);
      expect(stats.scans).toBe(1);
    });

    it('keeps each tool call\'s edit of the same file when the metadata is a JSON string', async () => {
      // Rows with distinct toolUseIds are separate edits. Without the id they
      // collapse to the newest row per path and the older edit is never matched.
      const { matches } = fakeSessionDb(
        [
          { id: 'f1', file_path: '/workspace/src/a.ts', timestamp_ms: T0, metadata: asSQLite({ toolUseId: 't1' }) },
          { id: 'f2', file_path: '/workspace/src/a.ts', timestamp_ms: T0 + 30_000, metadata: asSQLite({ toolUseId: 't2' }) },
        ],
        [
          toolUseMessage(1, T0 - 1_000, 't1', '/workspace/src/a.ts'),
          toolUseMessage(2, T0 + 29_000, 't2', '/workspace/src/a.ts'),
        ],
      );

      await expect(toolCallMatcher.matchSession('sqlite-same-file')).resolves.toBe(2);

      expect(matches).toEqual([
        { session_file_id: 'f1', message_id: 1, tool_use_id: 't1', match_score: 100 },
        { session_file_id: 'f2', message_id: 2, tool_use_id: 't2', match_score: 100 },
      ]);
    });

    it.each([
      ['object (PGLite)', (metadata: Record<string, unknown>) => metadata],
      ['JSON string (SQLite)', asSQLite],
    ])('removes unmatched bash side-effect rows and keeps matched ones, metadata as %s', async (_shape, shape) => {
      const { matches, stats } = fakeSessionDb(
        [
          { id: 'bash-matched', file_path: '/workspace/src/kept.ts', timestamp_ms: T0, metadata: shape({ bashSideEffect: true }) },
          { id: 'bash-orphan', file_path: '/workspace/out/generated.txt', timestamp_ms: T0, metadata: shape({ bashSideEffect: true }) },
        ],
        [toolUseMessage(3, T0 - 1_000, 't-other', '/workspace/src/kept.ts')],
      );

      await expect(toolCallMatcher.matchSession('bash-cleanup')).resolves.toBe(1);

      expect(matches.map(m => m.session_file_id)).toEqual(['bash-matched']);
      expect(stats.deletedFileIds).toEqual(['bash-orphan']);
    });

    it('treats empty, invalid or non-object JSON metadata as no metadata without failing the pass', async () => {
      const { stats } = fakeSessionDb(
        ['', 'not json', '{"toolUseId":', 'null', '"t1"', '[{"toolUseId":"t1"}]'].map((metadata, i) => ({
          id: `bad-${i}`,
          file_path: `/workspace/src/bad-${i}.ts`,
          timestamp_ms: T0 + i,
          metadata,
        })),
        [],
      );

      await expect(toolCallMatcher.matchSession('bad-metadata')).resolves.toBe(0);

      expect(logger.main.error).not.toHaveBeenCalled();
      // No definitive id survives, so the lookup stays bounded to the edits.
      expect(stats).toEqual({ scans: 1, boundedScans: 1, rowsScanned: 0, deletedFileIds: [] });
    });

    it('N3: an invalid metadata row does not fail the session diff context', async () => {
      fakeSessionDb(
        [
          { id: 'n3-bad', file_path: '/workspace/src/bad.ts', timestamp_ms: T0, metadata: '{"toolUseId":' },
          { id: 'n3-ok', file_path: '/workspace/src/ok.ts', timestamp_ms: T0, metadata: asSQLite({ toolUseId: 'n3-tool' }) },
        ],
        [],
      );

      const ctx = await toolCallMatcher.createSessionEnrichmentContext('n3-context');

      expect([...ctx.editedByToolUseId.keys()]).toEqual(['n3-tool']);
      expect(ctx.sessionFilesById.get('n3-bad')).toEqual({ file_path: '/workspace/src/bad.ts', metadata: {} });
    });

    it('N3: an invalid metadata row does not fail the per-call diff lookup', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("metadata->>'toolUseId'")) return { rows: [] }; // no direct session_files link
        if (/SELECT message_id\s+FROM ai_tool_call_file_edits/.test(sql)) return { rows: [{ message_id: 9 }] };
        if (sql.includes('FROM ai_tool_call_file_edits')) {
          return { rows: [{ session_file_id: 'n3-bad', message_id: 9, match_reason: 'name_in_args' }] };
        }
        if (sql.includes('FROM session_files')) {
          return { rows: [{ id: 'n3-bad', file_path: '/workspace/src/bad.ts', metadata: 'not json' }] };
        }
        return { rows: [] };
      });

      const diffs = await toolCallMatcher.getDiffsForToolCall('n3-per-call', 'n3-call');

      expect(diffs.map(d => [d.filePath, d.operation])).toEqual([['/workspace/src/bad.ts', 'edit']]);
      expect(logger.main.error).not.toHaveBeenCalled();
    });

    /**
     * Raw-message scan work over a session that grows one edit at a time, with
     * PASSES_PER_EDIT matchSession passes after each edit (the edit's own tool
     * call, later non-edit tool calls, end of turn). Each edit's tool call
     * names its file 500ms before the edit, so heuristics alone score it 40.
     */
    function runGrowingSession(fileToolUseId: (edit: number) => string) {
      const LEAD_ROWS = 20; // history before the first edit
      const FILLER_ROWS_PER_TURN = 10;
      const EDITS = 5;
      const PASSES_PER_EDIT = 4;
      const files: FileRow[] = [];
      const messages: MessageRow[] = [];
      let nextId = 1;
      for (let i = 0; i < LEAD_ROWS; i++) messages.push(textMessage(nextId++, T0 + i * 1_000));
      const db = fakeSessionDb(files, messages);
      return (async () => {
        for (let edit = 1; edit <= EDITS; edit++) {
          const turnStart = T0 + edit * 60_000;
          for (let i = 0; i < FILLER_ROWS_PER_TURN; i++) messages.push(textMessage(nextId++, turnStart + i * 1_000));
          const filePath = `/workspace/src/file-${edit}.ts`;
          messages.push(toolUseMessage(nextId++, turnStart + 10_000, `t${edit}`, filePath));
          files.push({ id: `f${edit}`, file_path: filePath, timestamp_ms: turnStart + 10_500, metadata: asSQLite({ toolUseId: fileToolUseId(edit) }) });
          for (let pass = 0; pass < PASSES_PER_EDIT; pass++) await toolCallMatcher.matchSession('growing-session');
        }
        return {
          scans: db.stats.scans,
          boundedScans: db.stats.boundedScans,
          rowsScanned: db.stats.rowsScanned,
          scores: db.matches.map(m => m.match_score),
        };
      })();
    }

    // Rows in the session when edit k lands: 20 lead rows plus 11 per turn.
    const sessionRowsAtEdit = (k: number) => 20 + 11 * k;
    const sumOverEdits = (f: (k: number) => number) => [1, 2, 3, 4, 5].reduce((sum, k) => sum + f(k), 0);

    it('scan work, every toolUseId resolvable: one whole-session scan per new edit, none once settled', async () => {
      const measured = await runGrowingSession(edit => `t${edit}`);
      expect(measured).toEqual({
        scans: 5,
        boundedScans: 0,
        rowsScanned: sumOverEdits(sessionRowsAtEdit), // 265
        scores: [100, 100, 100, 100, 100],
      });
    });

    it('scan work, one toolUseId never resolvable: every pass scans the whole session, as on PGLite', async () => {
      // The first edit's id matches no tool call, so that file never settles
      // and keeps the unbounded lookup that exact ids require.
      const measured = await runGrowingSession(edit => (edit === 1 ? 'ghost' : `t${edit}`));
      expect(measured).toEqual({
        scans: 20,
        boundedScans: 0,
        rowsScanned: 4 * sumOverEdits(sessionRowsAtEdit), // 1060
        scores: [40, 100, 100, 100, 100],
      });
    });

    it.each(['nimtc|call_', 'watcher-', 'codex-bash-', 'codex-acp-write-'])(
      'B1: scan work, ids Nimbalyst minted (%s): only bounded scans, as before SQLite metadata was read',
      async prefix => {
        // A minted id is no provider tool-call id, so it does not justify a
        // whole-session read. Each pass reads from 10s before the first edit to
        // 10s after the latest: 11 rows per turn, less turn 1's opening row.
        const measured = await runGrowingSession(edit => `${prefix}${edit}`);
        expect(measured).toEqual({
          scans: 20,
          boundedScans: 20,
          rowsScanned: 4 * sumOverEdits(k => 11 * k - 1), // 640
          scores: [40, 40, 40, 40, 40],
        });
      },
    );

    describe('against a real SQLite database', () => {
      let tmp: string;
      let sqlite: SQLiteDatabase;

      beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-toolcall-metadata-'));
        const dbDir = path.join(tmp, 'sqlite-db');
        fs.mkdirSync(dbDir, { recursive: true });
        sqlite = new SQLiteDatabase({ dbDir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas') });
        await sqlite.initialize();
      });

      afterEach(async () => {
        try { await sqlite.close(); } catch { /* ignore */ }
        fs.rmSync(tmp, { recursive: true, force: true });
      });

      it('matches by toolUseId, removes the orphaned bash side effect, and skips the scan on the next pass', async () => {
        const sessionId = 'sqlite-real-session';
        const fileTs = T0;
        await sqlite.query(
          `INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, $3)`,
          [sessionId, '/workspace', 'claude-code'],
        );
        // Written through the production session_files store.
        const store = createPGLiteSessionFileStore(sqlite);
        const edited = await store.addFileLink({
          sessionId,
          workspaceId: '/workspace',
          filePath: '/workspace/src/kept.ts',
          linkType: 'edited',
          timestamp: fileTs,
          metadata: { toolName: 'Edit', operation: 'edit', toolUseId: 'toolu_exact' },
        });
        const orphan = await store.addFileLink({
          sessionId,
          workspaceId: '/workspace',
          filePath: '/workspace/out/generated.txt',
          linkType: 'edited',
          timestamp: fileTs,
          metadata: { bashSideEffect: true },
        });
        // The tool call is 60s before the edit: reachable only through the exact id.
        await sqlite.query(
          `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content) VALUES ($1, $2, $3, $4, $5)`,
          [
            sessionId,
            new Date(fileTs - 60_000).toISOString(),
            'claude-code',
            'output',
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id: 'toolu_exact', name: 'Edit', input: { file_path: '/workspace/src/kept.ts' } }] },
            }),
          ],
        );

        // Premise: SQLite returns the column as JSON text, not an object.
        const raw = await sqlite.query<{ metadata: unknown }>(`SELECT metadata FROM session_files WHERE id = $1`, [edited.id]);
        expect(typeof raw.rows[0].metadata).toBe('string');

        const sqlSeen: string[] = [];
        queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
          sqlSeen.push(sql);
          return sqlite.query(sql, params);
        });

        await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(1);
        expect(logger.main.error).not.toHaveBeenCalled();

        const stored = await sqlite.query(
          `SELECT session_file_id, tool_use_id, match_score FROM ai_tool_call_file_edits WHERE session_id = $1`,
          [sessionId],
        );
        expect(stored.rows).toEqual([{ session_file_id: edited.id, tool_use_id: 'toolu_exact', match_score: 100 }]);
        const remaining = await sqlite.query<{ id: string }>(`SELECT id FROM session_files WHERE session_id = $1`, [sessionId]);
        // The orphaned bash side effect is gone; the matched edit stays.
        expect(orphan.id).not.toBe(edited.id);
        expect(remaining.rows.map(r => r.id)).toEqual([edited.id]);

        sqlSeen.length = 0;
        await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(0);
        expect(sqlSeen.some(sql => sql.includes('FROM ai_agent_messages'))).toBe(false);
      });

      it('B1: a Codex app-server session reads no more raw rows than before SQLite metadata was read', async () => {
        // Rows as OpenAICodexProvider stores them on the app-server transport
        // ({method, params} content) and session_files rows as SessionFileTracker
        // writes them (toolUseId = the nimtc| edit-group id). No window carries
        // that id, so these files never settle.
        const sessionId = 'b1-codex-app-server';
        await sqlite.query(`INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, $3)`, [sessionId, '/workspace', 'openai-codex']);
        const store = createPGLiteSessionFileStore(sqlite);
        const stats = { scans: 0, unboundedScans: 0, rowsScanned: 0 };
        queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
          const result = await sqlite.query(sql, params);
          if (sql.includes('FROM ai_agent_messages')) {
            stats.scans++;
            if (!params || params.length < 3) stats.unboundedScans++;
            stats.rowsScanned += result.rows.length;
          }
          return result;
        });

        let t = T0;
        let item = 0;
        const row = async (method: string, body: Record<string, unknown>, turnId: string, editGroupId?: string) => {
          t += 3_000;
          await sqlite.query(
            `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
            [sessionId, new Date(t).toISOString(), 'openai-codex', 'output',
              JSON.stringify({ method, params: { threadId: 'thr-1', turnId, item: body } }),
              JSON.stringify({ eventType: method, codexProvider: true, transport: 'app-server', ...(editGroupId ? { editGroupId } : {}) })],
          );
        };
        const command = async (turnId: string, cmd: string) => {
          const id = `call_${++item}`;
          const editGroupId = `nimtc|${id}|${t}|${item}`;
          await row('item/completed', { type: 'reasoning', id: `rs_${item}`, summary: ['Looking at the code'], content: [] }, turnId);
          await row('item/started', { type: 'commandExecution', id, command: cmd, status: 'inProgress' }, turnId, editGroupId);
          await row('item/completed', { type: 'commandExecution', id, command: cmd, aggregatedOutput: 'output\n', exitCode: 0, status: 'completed' }, turnId, editGroupId);
          await toolCallMatcher.matchSession(sessionId);
        };
        // One task over five turns (explore, edit, verify); a.ts is edited twice.
        const turns = [
          { explore: 12, edits: ['/workspace/src/a.ts', '/workspace/src/b.ts'], verify: 4 },
          { explore: 6, edits: ['/workspace/src/a.ts'], verify: 3 },
          { explore: 8, edits: [] as string[], verify: 0 },
          { explore: 5, edits: ['/workspace/src/c.ts'], verify: 3 },
          { explore: 10, edits: [] as string[], verify: 0 },
        ];
        for (const [k, turn] of turns.entries()) {
          const turnId = `turn-${k}`;
          for (let i = 0; i < turn.explore; i++) await command(turnId, `rg -n thing src/file${i}.ts`);
          for (const filePath of turn.edits) {
            const id = `call_${++item}`;
            const editGroupId = `nimtc|${id}|${t}|${item}`;
            await row('item/completed', { type: 'fileChange', id, status: 'completed', changes: [{ path: filePath, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] }, turnId, editGroupId);
            await store.addFileLink({ sessionId, workspaceId: '/workspace', filePath, linkType: 'edited', timestamp: t, metadata: { toolName: 'file_change', operation: 'edit', toolUseId: editGroupId } });
            await toolCallMatcher.matchSession(sessionId);
          }
          for (let i = 0; i < turn.verify; i++) await command(turnId, 'pnpm test');
          await row('item/completed', { type: 'agentMessage', id: `msg_${k}`, text: 'Done.' }, turnId);
          await row('turn/completed', { id: turnId }, turnId);
          await toolCallMatcher.matchSession(sessionId); // end of turn
          t += 60_000; // the user reads and answers
        }

        const stored = await sqlite.query(`SELECT id FROM ai_tool_call_file_edits WHERE session_id = $1`, [sessionId]);
        expect(stored.rows).toEqual([]);
        expect(logger.main.error).not.toHaveBeenCalled();
        // Before SQLite metadata was read, the same replay made 48 bounded scans
        // of 2339 rows in total (the parse alone made them unbounded: 4856 rows).
        expect(stats).toEqual({ scans: 48, unboundedScans: 0, rowsScanned: 2339 });
      });

      it('B2: the per-call diff of a Write that created a file reports create on SQLite', async () => {
        const sessionId = 'b2-diff-operation';
        await sqlite.query(`INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, $3)`, [sessionId, '/workspace', 'claude-code']);
        await createPGLiteSessionFileStore(sqlite).addFileLink({
          sessionId,
          workspaceId: '/workspace',
          filePath: '/workspace/src/new.ts',
          linkType: 'edited',
          timestamp: T0,
          metadata: { toolName: 'Write', operation: 'create', toolUseId: 'toolu_b2_write' },
        });
        queryMock.mockImplementation((sql: string, params?: unknown[]) => sqlite.query(sql, params));
        AISessionsRepository.setStore({ get: async () => ({ provider: 'claude-code' }) } as unknown as Parameters<typeof AISessionsRepository.setStore>[0]);
        const hasService = vi.spyOn(TranscriptMigrationRepository, 'hasService').mockReturnValue(true);
        const getService = vi.spyOn(TranscriptMigrationRepository, 'getService').mockReturnValue({
          findToolCallByProviderId: async (_session: string, id: string) => (id === 'toolu_b2_write'
            ? { payload: { toolName: 'Write', arguments: { file_path: '/workspace/src/new.ts', content: 'export const x = 1;\n' } } }
            : null),
        } as unknown as ReturnType<typeof TranscriptMigrationRepository.getService>);
        try {
          const result = await toolCallMatcher.getDiffsForToolCallResult(sessionId, 'toolu_b2_write');

          expect(result.diffs.map(d => [d.filePath, d.operation, d.content])).toEqual([
            ['/workspace/src/new.ts', 'create', 'export const x = 1;\n'],
          ]);
        } finally {
          hasService.mockRestore();
          getService.mockRestore();
          AISessionsRepository.clearStore();
        }
      });
    });
  });
});
