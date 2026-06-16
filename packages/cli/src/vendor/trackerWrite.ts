/**
 * VENDORED write-path helpers for offline (direct-mode) tracker mutations.
 *
 * These mirror the app's MCP tool handlers + identity service so a CLI-written
 * row is shaped identically to an app-written one:
 *   - `getCurrentIdentity` — copy of the git-config branch of
 *     packages/electron/src/main/services/TrackerIdentityService.ts. The app
 *     also checks Stytch auth first, but Stytch state only exists inside the
 *     running app; an offline CLI has no app session, so we resolve identity
 *     from git config (then anonymous), which is exactly the app's fallback.
 *   - `appendActivity` — copy of the private helper in
 *     packages/electron/src/main/mcp/tools/trackerToolHandlers.ts.
 *   - `buildComment` — the comment shape from `handleTrackerAddComment`.
 *
 * KEEP IN SYNC with those sources.
 */
import { execSync } from 'child_process';

export interface TrackerIdentity {
  email: string | null;
  displayName: string;
  gitName?: string | null;
  gitEmail?: string | null;
}

function getGitUserConfig(workspacePath?: string): { gitName: string | null; gitEmail: string | null } {
  const cwd = workspacePath || process.cwd();
  let gitName: string | null = null;
  let gitEmail: string | null = null;
  try {
    gitName = execSync('git config user.name', { cwd, stdio: 'pipe' }).toString().trim() || null;
  } catch {
    /* git not configured or not a git repo */
  }
  try {
    gitEmail = execSync('git config user.email', { cwd, stdio: 'pipe' }).toString().trim() || null;
  } catch {
    /* git not configured or not a git repo */
  }
  return { gitName, gitEmail };
}

/**
 * Resolve the current user's identity for offline authorship. Mirrors the app's
 * priority chain minus Stytch (unavailable offline): git config, then anonymous.
 */
export function getCurrentIdentity(workspacePath?: string): TrackerIdentity {
  const { gitName, gitEmail } = getGitUserConfig(workspacePath);
  if (gitEmail || gitName) {
    return {
      email: gitEmail,
      displayName: gitName || gitEmail || 'Local User',
      gitName,
      gitEmail,
    };
  }
  return { email: null, displayName: 'Local User', gitName: null, gitEmail: null };
}

/**
 * Append an entry to `data.activity`, bounded to the last 100 entries. Exact
 * copy of the handler's private `appendActivity`.
 */
export function appendActivity(
  data: Record<string, any>,
  authorIdentity: any,
  action: string,
  details?: { field?: string; oldValue?: string; newValue?: string },
): void {
  const activity = data.activity || [];
  activity.push({
    id: `activity_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    authorIdentity,
    action,
    field: details?.field,
    oldValue: details?.oldValue,
    newValue: details?.newValue,
    timestamp: Date.now(),
  });
  if (activity.length > 100) {
    data.activity = activity.slice(-100);
  } else {
    data.activity = activity;
  }
}

/** The comment shape pushed by `handleTrackerAddComment`. */
export function buildComment(authorIdentity: TrackerIdentity, body: string): {
  id: string;
  authorIdentity: TrackerIdentity;
  body: string;
  createdAt: number;
  updatedAt: null;
  deleted: false;
} {
  return {
    id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    authorIdentity,
    body,
    createdAt: Date.now(),
    updatedAt: null,
    deleted: false,
  };
}

/** Allocate a fresh native tracker id, matching the handler's scheme. */
export function newTrackerId(type: string): string {
  return `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
