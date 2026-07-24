const LEGACY_ISSUE_KEY_PREFIX = 'NIM';

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
