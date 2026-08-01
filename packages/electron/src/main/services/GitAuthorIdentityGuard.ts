import type { SimpleGit } from 'simple-git';
// Plain-JS shared module (no build step -- see packages/shared/forbiddenGitAuthors.mjs
// for why) with a companion forbiddenGitAuthors.d.mts alongside it for these types.
import { findForbiddenAuthors } from '../../../../shared/forbiddenGitAuthors.mjs';

export interface ResolvedGitAuthor {
  name: string;
  email: string;
}

const AUTHOR_IDENT_PATTERN = /^(.*) <([^>]*)> \d+ [+-]\d{4}\s*$/;

/**
 * Ask git itself which author identity the *next* commit in this repo would
 * carry. `git var GIT_AUTHOR_IDENT` walks the exact same GIT_AUTHOR_NAME/EMAIL
 * env -> repo config -> global config -> gecos/hostname fallback chain that
 * `git commit` uses, so checking it (rather than just `git config user.name`)
 * also catches an identity supplied purely through env vars, which config
 * lookups alone would miss (see testSupport/gitTestSandbox.ts, rule #2).
 */
export async function resolveGitAuthorIdentity(git: SimpleGit): Promise<ResolvedGitAuthor> {
  const raw = (await git.raw(['var', 'GIT_AUTHOR_IDENT'])).trim();
  const match = AUTHOR_IDENT_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`Could not parse the resolved git author identity: "${raw}"`);
  }
  return { name: match[1], email: match[2] };
}

/**
 * Returns a human-readable "Name <email>" description when the identity
 * matches the shared fixture denylist (packages/shared/forbiddenGitAuthors.mjs
 * -- the same list scripts/check-push-authors.mjs enforces at push time), or
 * null when the identity is allowed.
 */
export function describeForbiddenGitAuthor(author: ResolvedGitAuthor): string | null {
  const [offender] = findForbiddenAuthors([author]);
  return offender ? `${offender.name} <${offender.email}>` : null;
}
