/**
 * Counts derived from a workspace scan.
 *
 * `getWorkspaceFiles` walks the workspace under a file budget and a depth
 * budget and stops the moment either runs out, returning `limited: true`. Every
 * count taken from that result is therefore a LOWER BOUND, not a total, and a
 * bare number presents a partial scan as a definitive answer (#1376: a
 * workspace holding 207 markdown files reported "16 markdown files", because
 * the budget was exhausted by large asset directories that `readdir` returned
 * before `docs/` and `specs/`).
 *
 * `fileCount` already carried the `N+` suffix for exactly this reason. These
 * helpers exist so its siblings cannot drift away from that decision again.
 */

/**
 * The markdown predicate used for the workspace cards. Kept byte-identical to
 * the two inline copies it replaces, extension-cased included, so this change
 * moves no counts on its own.
 */
export function isMarkdownFile(relativePath: string): boolean {
  return relativePath.endsWith('.md') || relativePath.endsWith('.markdown');
}

/**
 * Render a scanned count honestly: `1000+` when the scan gave up, the plain
 * number when it completed. Returns `number | string` because that is the shape
 * `fileCount` has always sent to the renderer.
 */
export function formatScannedCount(count: number, limited: boolean): number | string {
  return limited ? `${count}+` : count;
}

export interface WorkspaceScanCounts {
  fileCount: number | string;
  markdownCount: number | string;
  limited: boolean;
}

/**
 * Summarize a `getWorkspaceFiles` result into the counts the workspace card and
 * the stats panel display. Pure, so the truncation behaviour is testable
 * without Electron or a filesystem.
 */
export function summarizeWorkspaceScan(scan: {
  files: string[];
  limited: boolean;
}): WorkspaceScanCounts {
  const markdown = scan.files.filter(isMarkdownFile).length;
  return {
    fileCount: formatScannedCount(scan.files.length, scan.limited),
    markdownCount: formatScannedCount(markdown, scan.limited),
    limited: scan.limited,
  };
}
