/**
 * Project-key matching for the `projects` map in `~/.claude.json`.
 *
 * Nimbalyst and Claude Code write that map with different path separators.
 * Nimbalyst passes native Windows paths (`C:\work\industrylens`); Claude Code
 * writes forward slashes (`C:/work/industrylens`). The lookup was an exact
 * string comparison, so on Windows the two never matched: every project-scoped
 * MCP server was invisible to Nimbalyst, and writes created a second entry
 * Claude Code could not read.
 *
 * One project can legitimately be present under both forms already, so an exact
 * hit always wins and only an unambiguous normalized hit is used as a fallback.
 */

/**
 * Canonical form for comparing two project keys.
 *
 * Separators are unified and a trailing one dropped. Only the drive letter is
 * case-folded: Windows drive letters vary by who wrote the string, but the rest
 * of the path is left alone so this stays correct on case-sensitive filesystems.
 */
/** Shape of one entry in the `projects` map that this module cares about. */
export interface ProjectEntry {
  mcpServers?: Record<string, unknown>;
}

export function normalizeProjectPathKey(projectPath: string): string {
  const unified = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return unified.replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`);
}

/**
 * Find the key in `projects` that refers to `workspacePath`, or undefined.
 *
 * Returns the key as it is actually stored, so callers read and write the entry
 * the other tool already owns instead of forking a second one.
 */
export function resolveProjectConfigKey(
  projects: Record<string, ProjectEntry | undefined> | undefined,
  workspacePath: string,
): string | undefined {
  if (!projects || !workspacePath) return undefined;

  // Exact match wins: never change behaviour for a config that already worked.
  if (Object.prototype.hasOwnProperty.call(projects, workspacePath)) {
    return workspacePath;
  }

  const target = normalizeProjectPathKey(workspacePath);
  const matches = Object.keys(projects)
    .filter((key) => normalizeProjectPathKey(key) === target)
    .sort(); // deterministic, so the same config always resolves the same way

  if (matches.length <= 1) return matches[0];

  // Several keys refer to the same folder. This happens for real: Claude Code
  // writes the drive letter inconsistently, leaving e.g. `C:/industrylens`
  // holding the servers and `c:/industrylens` empty. Prefer whichever entry
  // actually has servers, so a duplicate empty key cannot hide a populated one.
  const populated = matches.filter((key) => hasServers(projects[key]));
  return populated[0] ?? matches[0];
}

function hasServers(entry: ProjectEntry | undefined): boolean {
  return Object.keys(entry?.mcpServers ?? {}).length > 0;
}
