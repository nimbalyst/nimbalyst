/**
 * TrackerIdentityService -- resolves the current user's TrackerIdentity
 * using a priority chain: Stytch auth > git config > anonymous.
 *
 * Also provides the `isMyItem()` utility for filtering "my items".
 */

import { execFileSync } from 'child_process';
import type { TrackerIdentity, TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
import { getUserEmail, getAuthState } from './StytchAuthService';

interface GitUserConfig {
  gitName: string | null;
  gitEmail: string | null;
}

/**
 * Git identity is a per-directory near-constant, but `getCurrentIdentity` is
 * called per incoming read-receipt message. Two synchronous `git config`
 * spawns per call put 4,782ms of a 5,125ms CPU profile inside `spawn` alone --
 * process creation is expensive, and far worse when the machine is swapping.
 *
 * The TTL is long because the value effectively never changes, but bounded so
 * someone who edits their git config does not have to restart to see it.
 */
const GIT_CONFIG_TTL_MS = 5 * 60 * 1000;
const gitConfigCache = new Map<string, { value: GitUserConfig; readAt: number }>();

/** Reset between tests. */
export function __resetGitIdentityCacheForTests(): void {
  gitConfigCache.clear();
}

function readGitConfigValue(cwd: string, key: string): string | null {
  try {
    // execFileSync, not execSync: no intermediate shell to spawn.
    return execFileSync('git', ['config', key], { windowsHide: true, cwd, stdio: 'pipe' }).toString().trim() || null;
  } catch {
    // git not configured or not a git repo
    return null;
  }
}

/**
 * Read git user config from a workspace directory.
 * Returns null values if git is not configured or the command fails.
 */
function getGitUserConfig(workspacePath?: string): GitUserConfig {
  const cwd = workspacePath || process.cwd();

  const cached = gitConfigCache.get(cwd);
  if (cached && Date.now() - cached.readAt < GIT_CONFIG_TTL_MS) {
    return cached.value;
  }

  // Cache the not-configured answer too. Without that, a directory that is not
  // a git repo respawns twice on every single call -- the worst case, not the
  // cheapest one.
  const value: GitUserConfig = {
    gitName: readGitConfigValue(cwd, 'user.name'),
    gitEmail: readGitConfigValue(cwd, 'user.email'),
  };
  gitConfigCache.set(cwd, { value, readAt: Date.now() });
  return value;
}

/**
 * Resolve the current user's TrackerIdentity using the priority chain:
 * 1. Stytch auth (logged in) -- email from Stytch, display name from user profile
 * 2. Git config (not logged in) -- email and name from git config
 * 3. Anonymous -- "Local User" with no email
 */
export function getCurrentIdentity(workspacePath?: string): TrackerIdentity {
  const { gitName, gitEmail } = getGitUserConfig(workspacePath);

  // Priority 1: Stytch auth (logged in)
  const stytchEmail = getUserEmail();
  if (stytchEmail) {
    const authState = getAuthState();
    const user = authState.user;
    const firstName = user?.name?.first_name;
    const lastName = user?.name?.last_name;
    const displayName = firstName
      ? `${firstName}${lastName ? ' ' + lastName : ''}`
      : stytchEmail.split('@')[0];

    return {
      email: stytchEmail,
      displayName,
      gitName,
      gitEmail,
    };
  }

  // Priority 2: Git config (not logged in)
  if (gitEmail || gitName) {
    return {
      email: gitEmail,
      displayName: gitName || gitEmail || 'Local User',
      gitName,
      gitEmail,
    };
  }

  // Priority 3: Anonymous
  return {
    email: null,
    displayName: 'Local User',
    gitName: null,
    gitEmail: null,
  };
}

/**
 * Check if a tracker item belongs to the current user.
 * Matches by email (strongest), then git email, then git name.
 * "My items" = items I authored OR am assigned to.
 */
export function isMyItem(item: TrackerItem, currentIdentity: TrackerIdentity): boolean {
  // Helper: case-insensitive match
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  // 1. Owner field -- check all identity facets (case-insensitive)
  if (item.owner) {
    if (currentIdentity.email && eq(item.owner, currentIdentity.email)) return true;
    if (currentIdentity.displayName && eq(item.owner, currentIdentity.displayName)) return true;
    if (currentIdentity.gitEmail && eq(item.owner, currentIdentity.gitEmail)) return true;
    if (currentIdentity.gitName && eq(item.owner, currentIdentity.gitName)) return true;
  }

  // 2. Assignee email -- check email identity facets
  if (item.assigneeEmail) {
    if (currentIdentity.email && eq(item.assigneeEmail, currentIdentity.email)) return true;
    if (currentIdentity.gitEmail && eq(item.assigneeEmail, currentIdentity.gitEmail)) return true;
  }

  // 3. Author identity -- email or git email
  if (item.authorIdentity?.email && currentIdentity.email) {
    if (eq(item.authorIdentity.email, currentIdentity.email)) return true;
  }
  if (item.authorIdentity?.gitEmail && currentIdentity.gitEmail) {
    if (eq(item.authorIdentity.gitEmail, currentIdentity.gitEmail)) return true;
  }

  return false;
}
