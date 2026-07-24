/**
 * Resolve where the genuine `claude` CLI persists a session's transcript jsonl,
 * and decide whether to RESUME vs start FRESH for a `claude-code-cli` session
 * (NIM-806, Phase 3 — BUG 3).
 *
 * The CLI rejects `--session-id <uuid>` once that id already exists on disk
 * (`Error: Session ID <uuid> is already in use.` → exit 1). On a relaunch of the
 * same Nimbalyst session (restart, IntersectionObserver re-mount, or
 * `ensureClaudeCliSession` after the prior PID is gone) re-passing the same
 * `--session-id` collides. So when the prior jsonl exists we switch to
 * `--resume <uuid>` instead — which ALSO restores prior context, which is what we
 * want across a restart. Detection is a pure function of the deterministic jsonl
 * path; the fs touch is injected at the call site.
 *
 * Path layout (verified live 2026-06-08):
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * The CLI encodes the project dir by replacing every non-alphanumeric character
 * with `-` (so `/`, `.`, and `_` all collapse to `-`). Verified against
 * `/Users/ghinkle/sources/stravu-editor` → `-Users-ghinkle-sources-stravu-editor`
 * and `/Users/ghinkle/sources/stravu-editor_worktrees/ample-wren` →
 * `-Users-ghinkle-sources-stravu-editor-worktrees-ample-wren` (the `_` became `-`).
 */

import path from 'path';

/** Encode a working directory the way the `claude` CLI names its projects dir. */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface ResolveClaudeCliJsonlPathInput {
  /** User home directory (os.homedir()). */
  homedir: string;
  /** Working directory the CLI was/will-be launched in. */
  cwd: string;
  /** The CLI session id (equals the Nimbalyst session id when it's a UUID). */
  sessionId: string;
}

/** Deterministic on-disk path of a CLI session's transcript jsonl. */
export function resolveClaudeCliJsonlPath(input: ResolveClaudeCliJsonlPathInput): string {
  const { homedir, cwd, sessionId } = input;
  return path.join(
    homedir,
    '.claude',
    'projects',
    encodeClaudeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
}

/**
 * Resume (vs start fresh) iff the CLI's jsonl for this id already exists. Pure so
 * the policy is unit-testable independent of the filesystem touch.
 */
export function shouldResumeClaudeCliSession(input: { jsonlExists: boolean }): boolean {
  return input.jsonlExists;
}
