import path from 'path';

/**
 * Infer a session worktree path from a file path an agent touched.
 *
 * This is the safety gate that lets a session ADOPT a worktree it created
 * mid-run (so diffs, local-history baselines, and file watchers follow it).
 * A path observed in model output is only trusted when it lives under the
 * session's own `<workspace>_worktrees/<name>` namespace: absolute escapes,
 * `..` traversal, and other projects' worktrees are all rejected, and the
 * resolved worktree can never leave that namespace. Adoption therefore cannot
 * be steered outside the current project, and the parent-project permission
 * boundary (via resolveProjectPath) is preserved.
 *
 * Returns the worktree root, or null when the path is not a trusted worktree.
 */
export function inferWorktreePathFromFilePath(
  workspacePath: string,
  filePath: string
): string | null {
  if (!workspacePath || !filePath) return null;
  const normalizedWorkspace = path.normalize(workspacePath);
  const normalizedFile = path.normalize(filePath);
  const worktreePrefix = `${normalizedWorkspace}_worktrees${path.sep}`;
  if (!normalizedFile.startsWith(worktreePrefix)) return null;

  const remainder = normalizedFile.slice(worktreePrefix.length);
  const worktreeName = remainder.split(path.sep)[0];
  if (!worktreeName || worktreeName.includes('..')) return null;

  const worktreePath = path.resolve(path.join(`${normalizedWorkspace}_worktrees`, worktreeName));
  if (!worktreePath.startsWith(worktreePrefix.slice(0, -1))) return null;
  return worktreePath;
}

/**
 * Infer a session worktree path from a shell command an agent ran (e.g. a
 * `cd .../<workspace>_worktrees/<name>` or a path argument). Same trust gate
 * as {@link inferWorktreePathFromFilePath}: only the session's own worktree
 * namespace is honored, `..` is rejected, and the result can never escape it.
 */
export function inferWorktreePathFromCommand(
  command: string | undefined,
  workspacePath: string
): string | null {
  if (!command || !workspacePath) return null;
  const normalizedWorkspace = path.normalize(workspacePath);
  const worktreePrefix = `${normalizedWorkspace}_worktrees${path.sep}`;
  const normalizedCommand = command.replace(/\\/g, path.sep);
  const idx = normalizedCommand.indexOf(worktreePrefix);
  if (idx === -1) return null;

  const after = normalizedCommand.slice(idx + worktreePrefix.length);
  const worktreeName = after.split(/[\s'"\r\n\\/]/)[0];
  if (!worktreeName || worktreeName.includes('..')) return null;

  const result = path.resolve(path.join(`${normalizedWorkspace}_worktrees`, worktreeName));
  if (!result.startsWith(worktreePrefix.slice(0, -1))) return null;
  return result;
}
