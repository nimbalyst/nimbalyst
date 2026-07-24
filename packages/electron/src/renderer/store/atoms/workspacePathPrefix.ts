/**
 * Platform-aware prefix check. Returns true iff `filePath` lives inside
 * the workspace rooted at `workspacePath`. Handles both POSIX (`/`) and
 * Windows (`\`) separators because the renderer receives absolute paths
 * from the main process which preserves the OS-native separator.
 *
 * Before #304 fix, the @-mention picker used `filePath.startsWith(workspacePath + '/')`
 * which silently dropped every file on Windows where the separator is `\`.
 * The empty-query path then fell through to the ripgrep search, which on
 * empty input returned alphabetical results - exactly the symptom Karl
 * reported.
 *
 * Lives in its own tiny module so unit tests can import it without
 * pulling the whole `fileMention.ts` import chain (which transitively
 * loads Lexical extension registration and fails outside a Lexical-aware
 * test setup).
 */
export function isPathInsideWorkspace(filePath: string, workspacePath: string): boolean {
  if (filePath === workspacePath) return true;
  // Accept either `/` or `\` immediately after the workspace prefix so the
  // check works regardless of which separator the OS uses, and so a sibling
  // path that happens to share the workspace name as a prefix (e.g.
  // `/workspaces/foo` vs `/workspaces/foo-archive`) does not match.
  return filePath.startsWith(workspacePath + '/') ||
         filePath.startsWith(workspacePath + '\\');
}
