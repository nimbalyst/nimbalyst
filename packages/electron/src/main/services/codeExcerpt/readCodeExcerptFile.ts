/**
 * Reads the file a code excerpt quotes, for the drift badge and for the
 * explicit "Quote lines" / "Update to current" actions. The path comes from
 * page markdown that a teammate may have written, so what can be read is
 * deliberately narrow:
 *
 * - Committed content only (`git cat-file blob HEAD:<path>`), never the
 *   working tree. Ignored and untracked files (where local secrets live) are
 *   not in HEAD, so they read as absent; uncommitted edits never leave the
 *   machine through an excerpt. It also keeps `commit:` honest: the snapshot
 *   is exactly the file at that commit.
 * - No dotfiles (`.env`, `.npmrc`, ...), even committed ones; dot directories
 *   such as `.github/` are allowed.
 * - The path must stay inside the workspace (no absolute paths, no `..`).
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface CodeExcerptFile {
  /** The file's text at HEAD, or null when it is not committed there. */
  text: string | null;
  /** Why the path was not read at all. */
  refused?: string;
  /** Short HEAD commit of the workspace repo, or null outside git. */
  head: string | null;
  /** Absolute path, for "Open file". */
  absolutePath: string;
}

/** The absolute path for a workspace-relative excerpt path, or null if it escapes the workspace. */
export function resolveExcerptPath(workspacePath: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath)) return null;
  const root = path.resolve(workspacePath);
  const absolute = path.resolve(root, relativePath);
  const back = path.relative(root, absolute);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return absolute;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5_000, maxBuffer: MAX_FILE_BYTES, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

export async function readCodeExcerptFile(workspacePath: string, relativePath: string): Promise<CodeExcerptFile> {
  const absolute = resolveExcerptPath(workspacePath, relativePath);
  if (!absolute) throw new Error('Excerpt path must be inside the workspace');
  const root = path.resolve(workspacePath);
  const repoPath = path.relative(root, absolute).split(path.sep).join('/');
  const head = (await git(root, ['rev-parse', '--short=9', 'HEAD']))?.trim() || null;
  if (path.posix.basename(repoPath).startsWith('.')) {
    return { text: null, refused: 'Dotfiles are not quoted.', head, absolutePath: absolute };
  }
  // `./` makes the path relative to the workspace, which may be a repo subfolder.
  const text = head ? await git(root, ['cat-file', 'blob', `HEAD:./${repoPath}`]) : null;
  return { text, head, absolutePath: absolute };
}
