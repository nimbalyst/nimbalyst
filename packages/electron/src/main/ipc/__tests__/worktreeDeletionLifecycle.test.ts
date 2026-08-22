// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'packages/electron/src/main/ipc/WorktreeHandlers.ts'),
  'utf8',
);
const start = source.indexOf("ipcMain.handle('worktree:delete'");
const end = source.indexOf("ipcMain.handle('worktree:archive'", start);
const deleteHandler = source.slice(start, end);

describe('worktree:delete lifecycle boundary', () => {
  it('delegates deletion to archiveWorktree instead of bypassing session retirement', () => {
    expect(deleteHandler).toContain('return archiveWorktree(worktreeId, workspacePath);');
    expect(deleteHandler).not.toContain('await worktreeStore.delete(worktreeId);');
  });
});
