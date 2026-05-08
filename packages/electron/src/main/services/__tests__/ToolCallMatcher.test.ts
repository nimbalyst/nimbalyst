import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    initialize: vi.fn(),
    query: vi.fn(),
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
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptEventRepository', () => ({
  TranscriptEventRepository: {
    hasStore: () => true,
    getStore: () => ({
      getMultiSessionEvents: mockGetMultiSessionEvents,
    }),
  },
}));

import { database } from '../../database/PGLiteDatabaseWorker';
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
});
