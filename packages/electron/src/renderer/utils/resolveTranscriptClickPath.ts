/**
 * Resolve a file path emitted in the AI transcript to an absolute path.
 *
 * Autolinked bare file paths (and some markdown links) are workspace-relative,
 * but the main-process file opener (`openFile` in FileOpener.ts) requires an
 * absolute path — it `existsSync`-checks the literal string and does NOT join
 * against the workspace, so a relative path silently opens a blank tab. Join
 * relative paths against the session's working directory (the worktree path for
 * worktree sessions, otherwise the workspace path). Absolute paths (POSIX `/`,
 * Windows `C:\` / `C:/`, or UNC `\\`) are returned unchanged.
 */
export function resolveTranscriptClickPath(filePath: string, baseDir?: string): string {
  const isAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(filePath);
  if (isAbsolute || !baseDir) return filePath;
  const trimmedBase = baseDir.replace(/[\\/]+$/, '');
  return `${trimmedBase}/${filePath}`;
}
