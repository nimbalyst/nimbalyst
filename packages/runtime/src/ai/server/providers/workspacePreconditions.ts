/**
 * Preconditions on the workspace directory an agent subprocess is spawned in.
 *
 * Every agent provider spawns its CLI with `cwd` set to the session's workspace
 * path. When that directory is gone -- the user moved, renamed, or deleted the
 * repo while the window stayed open -- Node reports the failed chdir as an
 * `ENOENT` naming the *command*, not the cwd:
 *
 *   spawn('/bin/echo', ['hi'], { cwd: '/gone' })
 *     -> Error: spawn /bin/echo ENOENT
 *
 * `/bin/echo` is present and executable; the path in the message is a red
 * herring. That lands on the user as "spawn .../codex ENOENT" and sends them
 * hunting for a corrupt install. The Claude Agent SDK guesses even worse: it
 * stats the binary, finds it present, and reports a libc/musl mismatch.
 *
 * So we check the directory ourselves before spawning and say what is actually
 * wrong. Workspace *opening* already validates the path; this covers the window
 * staying open while the folder moves out from under it.
 */

import * as fs from 'fs';

/**
 * Describe why `workspacePath` cannot be used as a spawn cwd, or return null
 * when it is usable.
 *
 * Returns a message rather than throwing because the call sites disagree on how
 * to surface it -- some throw, some yield an error chunk -- and each should keep
 * its own convention.
 */
export function describeUnusableWorkspacePath(workspacePath: string | undefined): string | null {
  if (!workspacePath) {
    return 'No project folder is set for this session, so there is nowhere to run the agent.';
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspacePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return `The project folder for this session no longer exists:\n  ${workspacePath}\n\nIt was moved, renamed, or deleted while the project was open. Reopen the project at its new location to continue.`;
    }
    return `The project folder for this session cannot be read (${error?.code ?? String(error)}):\n  ${workspacePath}`;
  }

  if (!stat.isDirectory()) {
    return `The project path for this session is not a folder:\n  ${workspacePath}`;
  }

  return null;
}
