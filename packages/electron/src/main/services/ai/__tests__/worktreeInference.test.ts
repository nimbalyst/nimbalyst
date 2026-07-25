import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  inferWorktreePathFromCommand,
  inferWorktreePathFromFilePath,
} from '../worktreeInference';

// Portable across OSes: build paths with the platform separator so the
// `<workspace>_worktrees/<name>` convention matches how AIService normalizes.
const workspace = path.join(path.sep === '\\' ? 'C:\\' : '/', 'projects', 'app');
const worktreesRoot = `${workspace}_worktrees`;
const taskWorktree = path.join(worktreesRoot, 'task');

describe('worktreeInference', () => {
  describe('inferWorktreePathFromFilePath', () => {
    it('adopts a file under the session worktree namespace', () => {
      const file = path.join(taskWorktree, 'src', 'index.ts');
      expect(inferWorktreePathFromFilePath(workspace, file)).toBe(taskWorktree);
    });

    it('ignores files inside the parent workspace itself', () => {
      const file = path.join(workspace, 'src', 'index.ts');
      expect(inferWorktreePathFromFilePath(workspace, file)).toBeNull();
    });

    it('rejects .. traversal in the worktree name', () => {
      const file = path.join(worktreesRoot, '..', 'escape', 'index.ts');
      expect(inferWorktreePathFromFilePath(workspace, file)).toBeNull();
    });

    it('does not adopt another project\'s worktree', () => {
      const otherWorktree = path.join(
        `${path.join(path.dirname(workspace), 'other')}_worktrees`,
        'task',
        'index.ts'
      );
      expect(inferWorktreePathFromFilePath(workspace, otherWorktree)).toBeNull();
    });

    it('returns null for empty inputs', () => {
      expect(inferWorktreePathFromFilePath('', 'x')).toBeNull();
      expect(inferWorktreePathFromFilePath(workspace, '')).toBeNull();
    });
  });

  describe('inferWorktreePathFromCommand', () => {
    it('adopts a worktree referenced by a shell command', () => {
      const command = `cd ${taskWorktree} && npm test`;
      expect(inferWorktreePathFromCommand(command, workspace)).toBe(taskWorktree);
    });

    it('rejects .. traversal embedded in a command path', () => {
      const command = `cat ${path.join(worktreesRoot, '..', 'secret')}`;
      expect(inferWorktreePathFromCommand(command, workspace)).toBeNull();
    });

    it('returns null when no worktree path is present', () => {
      expect(inferWorktreePathFromCommand('npm run build', workspace)).toBeNull();
    });
  });
});
