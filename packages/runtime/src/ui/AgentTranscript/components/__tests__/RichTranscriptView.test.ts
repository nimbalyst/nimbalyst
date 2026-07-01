import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import {
  buildIntermediateProgressCollapsePlan,
  extractEditsFromToolMessage,
  isInteractiveWidgetTool,
  isTranscriptAtBottom,
  parseUnifiedDiffToReplacements,
  shouldAutoScrollTranscript,
  stripMcpPrefix,
  toolCallDiffsToEdits,
} from '../RichTranscriptView';

function makeTestMessage(overrides: Partial<TranscriptViewMessage> = {}): TranscriptViewMessage {
  return {
    id: 1,
    sequence: 1,
    createdAt: new Date(),
    type: 'tool_call',
    subagentId: null,
    ...overrides,
  };
}

describe('extractEditsFromToolMessage', () => {
  it('deduplicates identical edits present on both message.edits and tool result payloads', () => {
    const duplicateEdit = {
      filePath: '/workspace/checkboxes.md',
      replacements: [
        {
          oldText: '- [ ] Delta',
          newText: '- [ ] Delta\n- [ ] Epsilon',
        },
      ],
    };

    const message = makeTestMessage({
      toolCall: {
        toolName: 'Edit',
        toolDisplayName: 'Edit',
        status: 'completed',
        description: null,
        arguments: {
          file_path: '/workspace/checkboxes.md',
        },
        targetFilePath: null,
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: 'tool-1',
        progress: [],
        result: JSON.stringify({
          success: true,
          edits: [duplicateEdit],
        }),
        changes: [{ path: duplicateEdit.filePath, patch: '' }],
      },
    });

    expect(extractEditsFromToolMessage(message)).toEqual([duplicateEdit]);
  });

  it('extracts Codex apply_patch edits from `changes` map with unified_diff', () => {
    // Mirrors what CodexACPProtocol's apply_patch tool emits: args.changes is
    // a record keyed by file path with { type, unified_diff } values.
    const message = makeTestMessage({
      toolCall: {
        toolName: 'ApplyPatch',
        toolDisplayName: 'ApplyPatch',
        status: 'completed',
        description: null,
        arguments: {
          path: '/repo/test-screenshot.md',
          call_id: 'call_abc',
          changes: {
            '/repo/test-screenshot.md': {
              type: 'update',
              move_path: null,
              unified_diff: '@@ -1 +1,2 @@\n # Test File\n+Small test edit added by Codex.\n',
            },
          },
          turn_id: 'turn_xyz',
        },
        targetFilePath: '/repo/test-screenshot.md',
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: 'call_abc',
        progress: [],
        result: JSON.stringify({ success: true }),
      },
    });

    const edits = extractEditsFromToolMessage(message);
    expect(edits).toHaveLength(1);
    expect(edits[0].filePath).toBe('/repo/test-screenshot.md');
    expect(edits[0].replacements).toHaveLength(1);
    expect(edits[0].replacements[0]).toEqual({
      oldText: '# Test File',
      newText: '# Test File\nSmall test edit added by Codex.',
    });
  });

  it('extracts Codex apply_patch new-file (type:add) into NewFilePreview-shaped edit', () => {
    const message = makeTestMessage({
      toolCall: {
        toolName: 'ApplyPatch',
        toolDisplayName: 'ApplyPatch',
        status: 'completed',
        description: null,
        arguments: {
          changes: {
            '/repo/new-file.md': {
              type: 'add',
              unified_diff: '@@ -0,0 +1,2 @@\n+Hello\n+World\n',
            },
          },
        },
        targetFilePath: '/repo/new-file.md',
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: 'call_def',
        progress: [],
        result: JSON.stringify({ success: true }),
      },
    });

    const edits = extractEditsFromToolMessage(message);
    expect(edits).toHaveLength(1);
    expect(edits[0].filePath).toBe('/repo/new-file.md');
    expect(edits[0].operation).toBe('create');
    expect(edits[0].content).toBe('Hello\nWorld');
  });

  it('uses changes[path].content (full file body) for type:add when present (real Codex shape)', () => {
    // Codex's apply_patch gives type:'add' entries a `content` field with the
    // full new-file body (not a unified_diff). Verified from real session
    // ai_agent_messages payloads.
    const message = makeTestMessage({
      toolCall: {
        toolName: 'ApplyPatch',
        toolDisplayName: 'ApplyPatch',
        status: 'completed',
        description: null,
        arguments: {
          changes: {
            '/repo/foo.test.ts': {
              type: 'add',
              content: "import { describe } from 'vitest';\n\ndescribe('x', () => {});\n",
            },
          },
        },
        targetFilePath: '/repo/foo.test.ts',
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: 'call_real',
        progress: [],
        result: JSON.stringify({ success: true }),
      },
    });

    const edits = extractEditsFromToolMessage(message);
    expect(edits).toHaveLength(1);
    expect(edits[0].operation).toBe('create');
    expect(edits[0].content).toBe("import { describe } from 'vitest';\n\ndescribe('x', () => {});\n");
  });

  describe('Codex file_change shape (legacy synchronous adapter, removed)', () => {
    // The synchronous extractFileChangeEdits adapter was removed because the raw
    // canonical event for Codex file_change carries no diff content. Diff rendering
    // is now handled by the main-process transcript enrichment path. The mapping
    // from resolved file diffs into EditToolResultCard input stays in
    // `toolCallDiffsToEdits` -- see the dedicated describe block below.
    it('extractEditsFromToolMessage returns [] for a file_change tool', () => {
      const message = makeTestMessage({
        toolCall: {
          toolName: 'file_change',
          toolDisplayName: 'File Change',
          status: 'completed',
          description: null,
          arguments: { changes: [{ path: '/repo/x.ts', kind: 'update' }] },
          targetFilePath: null,
          mcpServer: null,
          mcpTool: null,
          providerToolCallId: 'nimtc|item_0|1730000000000|42',
          progress: [],
          result: JSON.stringify({
            success: true,
            status: 'completed',
            changes: [{ path: '/repo/x.ts', kind: 'update' }],
          }),
        },
      });

      // No diff content on the canonical event => the synchronous extractor must
      // not synthesize a fake edit. The async dispatch path takes over.
      expect(extractEditsFromToolMessage(message)).toEqual([]);
    });
  });

  describe('toolCallDiffsToEdits', () => {
    // Adapter from the resolved transcript file-diff payload into the edit-record
    // shape EditToolResultCard expects. Used by the main-enriched file_change path,
    // whose raw item.completed payload has no diff content.

    it('maps an edit-operation diff to a replacements-style update edit', () => {
      const edits = toolCallDiffsToEdits([
        {
          filePath: '/repo/src/app.ts',
          operation: 'edit',
          diffs: [
            { oldString: 'export const x = 1;\n', newString: 'export const x = 2;\n' },
          ],
          linesAdded: 1,
          linesRemoved: 1,
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual({
        filePath: '/repo/src/app.ts',
        type: 'update',
        operation: 'edit',
        replacements: [
          { oldText: 'export const x = 1;\n', newText: 'export const x = 2;\n' },
        ],
      });
    });

    it('maps a multi-replacement edit into one update edit with all replacements', () => {
      const edits = toolCallDiffsToEdits([
        {
          filePath: '/repo/src/util.ts',
          operation: 'edit',
          diffs: [
            { oldString: 'A', newString: 'a' },
            { oldString: 'B', newString: 'b' },
          ],
          linesAdded: 2,
          linesRemoved: 2,
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].replacements).toEqual([
        { oldText: 'A', newText: 'a' },
        { oldText: 'B', newText: 'b' },
      ]);
    });

    it('maps a create-operation diff to a NewFilePreview-shaped edit', () => {
      const newContent = "import { describe } from 'vitest';\n\ndescribe('x', () => {});\n";
      const edits = toolCallDiffsToEdits([
        {
          filePath: '/repo/foo.test.ts',
          operation: 'create',
          diffs: [],
          content: newContent,
          linesAdded: 3,
          linesRemoved: 0,
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual({
        filePath: '/repo/foo.test.ts',
        type: 'add',
        operation: 'create',
        content: newContent,
      });
      // No old_string/new_string -- isNewFileEdit() in EditToolResultCard returns true
      // so this routes through NewFilePreview rather than DiffViewer.
      expect(edits[0].old_string).toBeUndefined();
      expect(edits[0].new_string).toBeUndefined();
    });

    it('maps a delete-operation diff to a red-only edit (new_string empty)', () => {
      const edits = toolCallDiffsToEdits([
        {
          filePath: '/repo/old.ts',
          operation: 'delete',
          diffs: [
            { oldString: 'export const removed = true;\n', newString: '' },
          ],
          linesAdded: 0,
          linesRemoved: 1,
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual({
        filePath: '/repo/old.ts',
        type: 'delete',
        operation: 'delete',
        old_string: 'export const removed = true;\n',
        new_string: '',
      });
    });

    it('emits one edit per file when the matcher returns multiple files for a single tool call', () => {
      const edits = toolCallDiffsToEdits([
        {
          filePath: '/repo/a.ts',
          operation: 'create',
          diffs: [],
          content: 'a-after\n',
        },
        {
          filePath: '/repo/b.ts',
          operation: 'edit',
          diffs: [{ oldString: 'b-before\n', newString: 'b-after\n' }],
        },
        {
          filePath: '/repo/c.ts',
          operation: 'delete',
          diffs: [{ oldString: 'c-before\n', newString: '' }],
        },
      ]);

      expect(edits).toHaveLength(3);
      expect(edits[0].operation).toBe('create');
      expect(edits[1].operation).toBe('edit');
      expect(edits[1].replacements[0]).toEqual({ oldText: 'b-before\n', newText: 'b-after\n' });
      expect(edits[2].operation).toBe('delete');
      expect(edits[2].old_string).toBe('c-before\n');
      expect(edits[2].new_string).toBe('');
    });

    it('drops entries without a filePath and tolerates empty diff arrays', () => {
      const edits = toolCallDiffsToEdits([
        { operation: 'edit', diffs: [] } as any,
        { filePath: '/repo/no-diffs.ts', operation: 'edit', diffs: [] },
      ]);

      // Missing filePath -> dropped. Empty diffs -> still emits an update edit, but
      // with replacements undefined so EditToolResultCard's DiffViewer falls
      // through to its own fallback rather than rendering an empty diff card.
      expect(edits).toHaveLength(1);
      expect(edits[0].filePath).toBe('/repo/no-diffs.ts');
      expect(edits[0].replacements).toBeUndefined();
    });

    it('returns [] for an empty input', () => {
      expect(toolCallDiffsToEdits([])).toEqual([]);
    });
  });

  describe('parseUnifiedDiffToReplacements', () => {
    it('returns one replacement per hunk and includes context lines on both sides', () => {
      const diff = '@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line3\n@@ -10 +10,2 @@\n-x\n+y\n+z\n';
      const replacements = parseUnifiedDiffToReplacements(diff);
      expect(replacements).toHaveLength(2);
      expect(replacements[0]).toEqual({
        oldText: 'line1\nold\nline3',
        newText: 'line1\nnew\nline3',
      });
      expect(replacements[1]).toEqual({
        oldText: 'x',
        newText: 'y\nz',
      });
    });

    it('returns [] for empty input', () => {
      expect(parseUnifiedDiffToReplacements('')).toEqual([]);
    });
  });

  it('keeps distinct edits for the same file', () => {
    const message = makeTestMessage({
      toolCall: {
        toolName: 'Edit',
        toolDisplayName: 'Edit',
        status: 'completed',
        description: null,
        arguments: {
          file_path: '/workspace/checkboxes.md',
        },
        targetFilePath: null,
        mcpServer: null,
        mcpTool: null,
        providerToolCallId: 'tool-2',
        progress: [],
        result: JSON.stringify({
          success: true,
          edits: [
            {
              filePath: '/workspace/checkboxes.md',
              replacements: [{ oldText: 'Alpha', newText: 'Alpha updated' }],
            },
            {
              filePath: '/workspace/checkboxes.md',
              replacements: [{ oldText: 'Beta', newText: 'Beta updated' }],
            },
          ],
        }),
      },
    });

    const edits = extractEditsFromToolMessage(message);
    expect(edits).toHaveLength(2);
    expect(edits[0].replacements[0].oldText).toBe('Alpha');
    expect(edits[1].replacements[0].oldText).toBe('Beta');
  });
});

describe('transcript auto-scroll thresholds', () => {
  it('treats distances under the shared threshold as being at the bottom', () => {
    expect(isTranscriptAtBottom(49)).toBe(true);
    expect(isTranscriptAtBottom(50)).toBe(false);
  });

  it('does not auto-scroll when the user already scrolled away past the bottom threshold', () => {
    expect(shouldAutoScrollTranscript(false, 80)).toBe(false);
  });

  it('still auto-scrolls when the transcript was sticky before the new content arrived', () => {
    expect(shouldAutoScrollTranscript(true, 200)).toBe(true);
  });
});

describe('intermediate assistant progress collapse planning', () => {
  const message = (index: number, type: TranscriptViewMessage['type'], text?: string, extra: Partial<TranscriptViewMessage> = {}): TranscriptViewMessage => ({
    id: index,
    sequence: index,
    createdAt: new Date(index),
    type,
    text,
    subagentId: null,
    ...extra,
  });

  it('collapses non-final assistant progress in each user turn', () => {
    const messages: TranscriptViewMessage[] = [
      message(1, 'user_message', 'start'),
      message(2, 'assistant_message', 'checking files'),
      message(3, 'assistant_message', 'running tests'),
      message(4, 'assistant_message', 'final answer'),
      message(5, 'user_message', 'next'),
      message(6, 'assistant_message', 'only answer'),
    ];

    const plan = buildIntermediateProgressCollapsePlan(messages, true);

    expect([...plan.collapsedIndices]).toEqual([1, 2]);
    expect(plan.groupsByStartIndex.get(1)).toEqual([1, 2]);
    expect(plan.collapsedIndices.has(3)).toBe(false);
    expect(plan.collapsedIndices.has(5)).toBe(false);
  });

  it('does not collapse when disabled and preserves special assistant messages', () => {
    const messages: TranscriptViewMessage[] = [
      message(1, 'user_message', 'start'),
      message(2, 'assistant_message', 'This session is being continued from a previous conversation.'),
      message(3, 'assistant_message', '401 from api.openai.com', { isError: true, isAuthError: true }),
      message(4, 'assistant_message', 'checking files'),
      message(5, 'assistant_message', 'final answer'),
    ];

    const disabled = buildIntermediateProgressCollapsePlan(messages, false);
    expect(disabled.collapsedIndices.size).toBe(0);

    const enabled = buildIntermediateProgressCollapsePlan(messages, true);
    expect([...enabled.collapsedIndices]).toEqual([3]);
    expect(enabled.groupsByStartIndex.get(3)).toEqual([3]);
    expect(enabled.collapsedIndices.has(1)).toBe(false);
    expect(enabled.collapsedIndices.has(2)).toBe(false);
  });
});

// Regression coverage for the user-reported bug on 2026-06-01: the
// "Thinking…" indicator stayed rendered on top of an AskUserQuestion widget
// that had already arrived in the transcript. The check at
// `isWaitingForResponse` was `toolName === 'AskUserQuestion'` strict equality,
// but the MCP-prefixed tool name `mcp__nimbalyst-mcp__AskUserQuestion` (the
// actual name on the wire for the in-app MCP server) never matches.
// The widget registry knew about both forms — the suppression check didn't.
describe('interactive widget tool name normalization', () => {
  it('strips the mcp__<server>__ prefix from MCP tool names', () => {
    expect(stripMcpPrefix('mcp__nimbalyst-mcp__AskUserQuestion')).toBe('AskUserQuestion');
    expect(stripMcpPrefix('mcp__nimbalyst__AskUserQuestion')).toBe('AskUserQuestion');
    expect(stripMcpPrefix('AskUserQuestion')).toBe('AskUserQuestion');
    expect(stripMcpPrefix('Read')).toBe('Read');
  });

  it('recognizes interactive widget tools whether bare or MCP-prefixed', () => {
    expect(isInteractiveWidgetTool('AskUserQuestion')).toBe(true);
    expect(isInteractiveWidgetTool('ExitPlanMode')).toBe(true);
    expect(isInteractiveWidgetTool('ToolPermission')).toBe(true);
    expect(isInteractiveWidgetTool('GitCommitProposal')).toBe(true);
    expect(isInteractiveWidgetTool('PromptForUserInput')).toBe(true);
    expect(isInteractiveWidgetTool('RequestUserInput')).toBe(true);

    expect(isInteractiveWidgetTool('mcp__nimbalyst-mcp__AskUserQuestion')).toBe(true);
    expect(isInteractiveWidgetTool('mcp__nimbalyst-mcp__ExitPlanMode')).toBe(true);
    expect(isInteractiveWidgetTool('mcp__nimbalyst__GitCommitProposal')).toBe(true);
    expect(isInteractiveWidgetTool('mcp__nimbalyst-mcp__PromptForUserInput')).toBe(true);
    expect(isInteractiveWidgetTool('mcp__nimbalyst-mcp__RequestUserInput')).toBe(true);

    expect(isInteractiveWidgetTool('Read')).toBe(false);
    expect(isInteractiveWidgetTool('mcp__nimbalyst-mcp__SomeOtherTool')).toBe(false);
    expect(isInteractiveWidgetTool('mcp__nimbalyst-mcp__capture_editor_screenshot')).toBe(false);
    expect(isInteractiveWidgetTool(undefined)).toBe(false);
    expect(isInteractiveWidgetTool(null)).toBe(false);
    expect(isInteractiveWidgetTool('')).toBe(false);
  });
});
