/**
 * Single source of truth for the git-fixture-identity denylist.
 *
 * On 2026-07-22 a vitest run that builds real git repos (GitCommitService.test.ts
 * and friends) escaped its temp sandbox during a release and pushed ten fixture
 * commits ("seed", "hook must reject", author "Test User") to public main.
 * scripts/check-push-authors.mjs added a push-time guard against that denylist.
 * NIM-431 adds an earlier guard at commit-proposal time (before the commit is
 * even made, in packages/electron's GitCommitService) using the same list --
 * this module is the shared definition so the two guards can never drift.
 *
 * Plain ESM, no build step: scripts/check-push-authors.mjs runs via a bare
 * `node` invocation in .githooks/pre-push before any TypeScript build, so this
 * file (and everything it imports) must be directly executable by Node with no
 * transpilation. packages/electron's TypeScript side gets types from the
 * companion forbiddenGitAuthors.d.mts next to this file.
 */

export const FORBIDDEN_NAMES = new Set(['Test', 'Test User', 'Your Name', 'Gate Author', 'NIM-367 Gate Author']);
export const FORBIDDEN_EMAIL_PATTERN = /(^test@|^fixture[-@]|@example\.(com|net|org)$|@test\.?$|\.(test|invalid|example)$)/i;

export function isForbiddenGitAuthor({ name, email }) {
  return FORBIDDEN_NAMES.has(name) || FORBIDDEN_EMAIL_PATTERN.test(email ?? '');
}

export function findForbiddenAuthors(commits) {
  return commits.filter((commit) => isForbiddenGitAuthor(commit));
}
