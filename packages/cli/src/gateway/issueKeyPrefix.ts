const LEGACY_ISSUE_KEY_PREFIX = 'NIM';

/**
 * Mirror of `packages/electron/src/shared/localIssueKey.ts`. The CLI writes to
 * SQLite directly and its rows drain through the app's backfill, so it has to
 * respect the same rule: only a tracker room may mint into the real issue
 * namespace.
 */
export const LOCAL_ISSUE_KEY_PREFIX = 'LC';

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
