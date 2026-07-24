import { afterEach, describe, expect, it } from 'vitest';
import {
  codexEditWindowRegistry,
  isWriteCapableMcpTool,
  shouldOpenCodexEditWindow,
} from '../CodexEditWindowRegistry';

describe('CodexEditWindowRegistry', () => {
  afterEach(() => {
    codexEditWindowRegistry.__resetForTests();
  });

  describe('shouldOpenCodexEditWindow', () => {
    it('does not auto-open windows for file_change (handled via pre_edit_snapshot)', () => {
      // file_change attribution moved to the OpenAICodexProvider
      // pre_edit_snapshot chunk path, which captures the real pre-edit
      // baseline directly from disk on item.started -- so the registry
      // no longer needs to auto-open a window for it.
      expect(shouldOpenCodexEditWindow('file_change')).toBe(false);
    });

    it('does not open windows for command_execution (per Phase 2 scope)', () => {
      expect(shouldOpenCodexEditWindow('command_execution')).toBe(false);
    });

    it('does not open windows for read tools', () => {
      expect(shouldOpenCodexEditWindow('Read')).toBe(false);
      expect(shouldOpenCodexEditWindow('Glob')).toBe(false);
    });

    it('opens windows for known write-capable MCP tools', () => {
      expect(isWriteCapableMcpTool('mcp__nimbalyst-mcp__applyCollabDocEdit')).toBe(true);
      expect(shouldOpenCodexEditWindow('mcp__nimbalyst-mcp__applyCollabDocEdit')).toBe(true);
    });

    it('does not open an edit window for an interactive commit proposal', () => {
      expect(isWriteCapableMcpTool('mcp__nimbalyst__developer_git_commit_proposal')).toBe(false);
      expect(shouldOpenCodexEditWindow('mcp__nimbalyst__developer_git_commit_proposal')).toBe(false);
    });

    it('does not open windows for unknown MCP tools', () => {
      expect(shouldOpenCodexEditWindow('mcp__some-server__unknown_tool')).toBe(false);
    });
  });

  describe('open / close lifecycle', () => {
    it('opens a window and tracks it by edit-group ID', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'nimtc|item_0|1700000000000|1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const window = codexEditWindowRegistry.getWindow('nimtc|item_0|1700000000000|1');
      expect(window).toBeDefined();
      expect(window!.status).toBe('open');
      expect(codexEditWindowRegistry.getSessionWindowCount('session-1')).toBe(1);
    });

    it('open is idempotent for the same edit-group ID', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'nimtc|item_0|1700000000000|1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const firstOpenedAt = codexEditWindowRegistry.getWindow('nimtc|item_0|1700000000000|1')!.openedAt;
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'nimtc|item_0|1700000000000|1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const secondOpenedAt = codexEditWindowRegistry.getWindow('nimtc|item_0|1700000000000|1')!.openedAt;
      expect(secondOpenedAt).toBe(firstOpenedAt);
    });

    it('close marks the window completed but keeps it for grace period matching', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      codexEditWindowRegistry.close('eg-1');
      const window = codexEditWindowRegistry.getWindow('eg-1');
      expect(window).toBeDefined();
      expect(window!.status).toBe('completed');
      expect(window!.closedAt).not.toBeNull();
    });
  });

  describe('findWindowForEdit', () => {
    it('returns the open window when the file timestamp falls inside it', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const win = codexEditWindowRegistry.getWindow('eg-1')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/a',
        filePath: '/ws/a/foo.ts',
        fileTimestamp: win.openedAt + 50,
      });
      expect(match).not.toBeNull();
      expect(match!.editGroupId).toBe('eg-1');
    });

    it('returns null when the timestamp is before the window opened', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const win = codexEditWindowRegistry.getWindow('eg-1')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/a',
        filePath: '/ws/a/foo.ts',
        fileTimestamp: win.openedAt - 50,
      });
      expect(match).toBeNull();
    });

    it('still matches within the post-close grace period', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      codexEditWindowRegistry.close('eg-1');
      const win = codexEditWindowRegistry.getWindow('eg-1')!;
      // Within grace period (1500ms by default)
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/a',
        filePath: '/ws/a/foo.ts',
        fileTimestamp: win.closedAt! + 500,
      });
      expect(match).not.toBeNull();
      expect(match!.editGroupId).toBe('eg-1');
    });

    it('rejects matches well past the post-close grace period', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      codexEditWindowRegistry.close('eg-1');
      const win = codexEditWindowRegistry.getWindow('eg-1')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/a',
        filePath: '/ws/a/foo.ts',
        fileTimestamp: win.closedAt! + 10_000, // way past grace
      });
      expect(match).toBeNull();
    });

    it('does not return windows from a different session', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-A',
        editGroupId: 'eg-A',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const winA = codexEditWindowRegistry.getWindow('eg-A')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-B',
        workspacePath: '/ws/a',
        filePath: '/ws/a/foo.ts',
        fileTimestamp: winA.openedAt + 10,
      });
      expect(match).toBeNull();
    });

    it('does not return windows from a different workspace', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const win = codexEditWindowRegistry.getWindow('eg-1')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/other',
        filePath: '/ws/other/foo.ts',
        fileTimestamp: win.openedAt + 10,
      });
      expect(match).toBeNull();
    });

    it('does not return a targeted window for a different file', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'mcp__nimbalyst-mcp__applyCollabDocEdit',
        workspacePath: '/ws/a',
        targetFilePath: 'docs/target.md',
      });
      const win = codexEditWindowRegistry.getWindow('eg-1')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/a',
        filePath: '/ws/a/docs/other.md',
        fileTimestamp: win.openedAt + 10,
      });
      expect(match).toBeNull();
    });

    it('returns a targeted window for the same normalized file', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'mcp__nimbalyst-mcp__applyCollabDocEdit',
        workspacePath: '/ws/a',
        targetFilePath: 'docs/target.md',
      });
      const win = codexEditWindowRegistry.getWindow('eg-1')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/a',
        filePath: '/ws/a/docs/target.md',
        fileTimestamp: win.openedAt + 10,
      });
      expect(match?.editGroupId).toBe('eg-1');
    });

    it('prefers the most recent window when multiple match', async () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-old',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      // Brief wait so opener timestamps differ
      await new Promise((r) => setTimeout(r, 10));
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-new',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      const winNew = codexEditWindowRegistry.getWindow('eg-new')!;
      const match = codexEditWindowRegistry.findWindowForEdit({
        sessionId: 'session-1',
        workspacePath: '/ws/a',
        filePath: '/ws/a/foo.ts',
        fileTimestamp: winNew.openedAt + 5,
      });
      expect(match).not.toBeNull();
      expect(match!.editGroupId).toBe('eg-new');
    });
  });

  describe('recordObservation', () => {
    it('records observed files on the matching window', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      codexEditWindowRegistry.recordObservation('eg-1', '/ws/a/foo.ts');
      codexEditWindowRegistry.recordObservation('eg-1', '/ws/a/bar.ts');
      const window = codexEditWindowRegistry.getWindow('eg-1')!;
      expect(window.observedFiles.has('/ws/a/foo.ts')).toBe(true);
      expect(window.observedFiles.has('/ws/a/bar.ts')).toBe(true);
    });

    it('silently ignores observations for unknown edit-group IDs', () => {
      expect(() => codexEditWindowRegistry.recordObservation('unknown', '/x.ts')).not.toThrow();
    });
  });

  describe('clearSession', () => {
    it('drops every window for the session', () => {
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-1',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      codexEditWindowRegistry.open({
        sessionId: 'session-1',
        editGroupId: 'eg-2',
        toolName: 'file_change',
        workspacePath: '/ws/a',
      });
      codexEditWindowRegistry.clearSession('session-1');
      expect(codexEditWindowRegistry.getSessionWindowCount('session-1')).toBe(0);
      expect(codexEditWindowRegistry.getWindow('eg-1')).toBeUndefined();
      expect(codexEditWindowRegistry.getWindow('eg-2')).toBeUndefined();
    });
  });
});
