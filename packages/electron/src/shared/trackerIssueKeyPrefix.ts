export const LEGACY_ISSUE_KEY_PREFIX = 'NIM';

/**
 * Derive a compact, Linear-style issue-key prefix from a project name or path.
 * Punctuation and path separators are ignored so `stravu-editor` becomes
 * `STR`. The tracker prefix validator requires at least two letters, so names
 * that cannot provide that fall back to the historical default.
 */
export function deriveIssueKeyPrefix(projectNameOrPath: string): string {
  const projectName = projectNameOrPath
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1) ?? '';
  const letters = projectName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toUpperCase();

  return letters.length >= 2 ? letters.slice(0, 3) : LEGACY_ISSUE_KEY_PREFIX;
}
