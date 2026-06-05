/**
 * Comma-separated glob matcher, matching the git extension's File Mask filter
 * exactly so users get the same syntax everywhere:
 *
 *   "*.ts,*.tsx"        — any .ts or .tsx file
 *   "src/** /*.test.ts" — recursive pattern
 *   "Readme*"           — case-insensitive filename match
 *
 * Glob semantics: `*` matches any run of non-slash characters, `**` matches
 * anything (across slashes), `?` matches a single non-slash character. The
 * pattern is matched against both the basename and the full path so users can
 * write either `*.ts` or `src/*.ts` and get what they expect.
 */

function globToRegex(glob: string): RegExp {
  // Escape regex special chars except * and ?
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Convert glob wildcards: ** -> match any path, * -> match any non-slash, ? -> single non-slash
  const pattern = escaped
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${pattern}$`, 'i');
}

export function parseFileMask(mask: string): RegExp[] {
  return mask
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegex);
}

export function matchesFileMask(path: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return true;
  const basename = path.split('/').pop() ?? path;
  return patterns.some((re) => re.test(basename) || re.test(path));
}
