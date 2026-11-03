/**
 * Main-process half of the post-sign-in project walk.
 *
 * An invited member's organization is on their account, but the organization a
 * project window shows is resolved per workspace from that workspace's git
 * remote. Someone who signs in and opens an unrelated folder therefore reads as
 * having no organization at all. This service answers the three questions the
 * walk asks: is anything unbound, what can this folder be used for, and make it
 * so. The rules themselves are in `shared/orgProjectWalk.ts`; everything here is
 * the git / filesystem / IPC that feeds them.
 *
 * Deliberately not a window opener: the walk finishes by calling the existing
 * `team:open-project-workspace`, so this module stays importable from a unit
 * test without dragging in WindowManager.
 *
 * See nimbalyst-local/plans/simpler-org-signup-flow.md.
 */

import { BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { readdir, rm, stat } from 'fs/promises';
import { createHash } from 'crypto';

import {
  classifyCloneFailure,
  classifyProjectFolder,
  cloneRefusedExistingDestination,
  isSafeCloneUrl,
  parseCloneProgress,
  redactRemoteAddresses,
  shouldRemoveFailedCloneDestination,
  type CloneFailureKind,
  type FailedCloneDestinationEvidence,
  type ProjectFolderVerdict,
  type ProjectWalkOrg,
} from '../../shared/orgProjectWalk';
import { getNormalizedGitRemote, invalidateGitRemoteCache } from '../utils/gitUtils';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import {
  getWindowIdForWindow,
  listOpenWorkspacePaths,
  resolveActiveWorkspacePathForWindowId,
} from '../window/windowState';
import {
  bindWorkspaceToSharedProject,
  broadcastWorkspaceOrgChanged,
  findTeamForWorkspace,
  listTeams,
  type TeamProjectSummary,
} from './TeamService';

export interface ProjectWalkStateResult {
  orgs: ProjectWalkOrg[];
  boundOrgIds: string[];
  /** The organization the asking window's own workspace resolves to, if any. */
  thisWindowOrgId: string | null;
}

/** Progress pushed to the window that started a clone. */
export const PROJECT_CLONE_PROGRESS_CHANNEL = 'team:project-clone-progress';

function hashRemote(remote: string): string {
  return createHash('sha256').update(remote).digest('hex');
}

/**
 * The account's active-member organizations, which of them an already-open
 * workspace resolves to, and which one the asking window is itself in.
 *
 * `findTeamForWorkspace` is the same lookup every org surface uses, so a folder
 * counted as bound here is exactly a folder those surfaces will resolve.
 *
 * The asking window's own organization is reported separately because the two
 * facts drive opposite decisions: any window being bound is a reason not to
 * interrupt, while only THIS window being bound is a reason to stop offering it
 * a way in. `thisWindowPath` is read out of the same batch of matches rather
 * than looked up again, so it costs no extra git spawn.
 */
export async function resolveProjectWalkState(
  thisWindowPath?: string | null,
): Promise<ProjectWalkStateResult> {
  const teams = await listTeams();
  const orgs = teams
    .filter((team) => !team.membershipType || team.membershipType === 'active_member')
    .map((team) => ({ orgId: team.orgId, name: team.name }));

  const boundOrgIds = new Set<string>();
  let thisWindowOrgId: string | null = null;
  const openPaths = listOpenWorkspacePaths();
  const matches = await Promise.all(
    openPaths.map((path) => findTeamForWorkspace(path).catch(() => null)),
  );
  for (const [index, match] of matches.entries()) {
    if (!match?.orgId) continue;
    boundOrgIds.add(match.orgId);
    if (thisWindowPath && openPaths[index] === thisWindowPath) thisWindowOrgId = match.orgId;
  }

  return { orgs, boundOrgIds: [...boundOrgIds], thisWindowOrgId };
}

/**
 * The project's registry row. Falls back to the org's own identity for a
 * listing that predates per-project rows, the same way binding does.
 */
async function resolveProjectSummary(
  orgId: string,
  teamProjectId: string,
): Promise<Pick<TeamProjectSummary, 'gitRemoteHash' | 'name' | 'slug' | 'remoteUrl'>> {
  const teams = await listTeams();
  const team = teams.find((candidate) => (
    candidate.orgId === orgId
    && (!candidate.membershipType || candidate.membershipType === 'active_member')
  ));
  if (!team) throw new Error('You are not a member of that organization');

  const project = team.projects?.find((candidate) => candidate.teamProjectId === teamProjectId)
    ?? (team.teamProjectId === teamProjectId
      ? { gitRemoteHash: team.gitRemoteHash, name: team.name, slug: null, remoteUrl: undefined }
      : undefined);
  if (!project) throw new Error('That project is no longer part of this organization');
  return project;
}

async function readFolderFacts(directoryPath: string) {
  if (!existsSync(directoryPath)) {
    return { exists: false, isDirectory: false, isEmpty: true, folderRemoteHash: null };
  }
  const stats = await stat(directoryPath);
  if (!stats.isDirectory()) {
    return { exists: true, isDirectory: false, isEmpty: false, folderRemoteHash: null };
  }
  const entries = await readdir(directoryPath);
  // A lone .DS_Store is not the user's files; refusing on it would be baffling.
  const meaningful = entries.filter((entry) => entry !== '.DS_Store');
  const remote = await getNormalizedGitRemote(directoryPath);
  return {
    exists: true,
    isDirectory: true,
    isEmpty: meaningful.length === 0,
    folderRemoteHash: remote ? hashRemote(remote) : null,
  };
}

export async function inspectProjectFolder(input: {
  orgId: string;
  teamProjectId: string;
  directoryPath: string;
}): Promise<ProjectFolderVerdict> {
  if (!input?.directoryPath) throw new Error('Inspecting a project folder requires a directory');
  const project = await resolveProjectSummary(input.orgId, input.teamProjectId);
  const facts = await readFolderFacts(input.directoryPath);
  return classifyProjectFolder(facts, project.gitRemoteHash ?? null);
}

/** Why a folder can't serve as this project's, in the user's terms. */
function explainRefusal(verdict: ProjectFolderVerdict, projectLabel: string): string {
  switch (verdict.kind) {
    case 'notADirectory':
      return 'That path is a file, not a folder.';
    case 'wrongRemote':
      return `That folder's git remote connects it to a different project. Choose the folder you cloned ${projectLabel} into.`;
    default:
      return `That folder is not a clone of ${projectLabel}. Clone the repository, or choose the folder you already cloned it into.`;
  }
}

/**
 * Make `directoryPath` the folder for a project, so `findTeamForWorkspace`
 * resolves the organization for it afterwards.
 *
 * A repository-backed project is matched by its remote, so an existing clone
 * needs no binding at all — recording one would give the project two answers.
 * A remote-less project has nothing to match on and is bound by name, which is
 * the flow `team:open-shared-project` already owns.
 */
export async function joinOrgProjectWithFolder(input: {
  orgId: string;
  teamProjectId: string;
  directoryPath: string;
}): Promise<{ workspacePath: string; method: 'bind' | 'existing' }> {
  const { orgId, teamProjectId, directoryPath } = input ?? {};
  if (!directoryPath) throw new Error('Joining a project requires a directory');

  const project = await resolveProjectSummary(orgId, teamProjectId);

  if (!project.gitRemoteHash) {
    await bindWorkspaceToSharedProject({ orgId, teamProjectId, directoryPath });
    broadcastWorkspaceOrgChanged({ orgId, workspacePath: directoryPath });
    return { workspacePath: directoryPath, method: 'bind' };
  }

  const facts = await readFolderFacts(directoryPath);
  const verdict = classifyProjectFolder(facts, project.gitRemoteHash);
  if (verdict.kind !== 'alreadyCloned') {
    throw new Error(explainRefusal(verdict, project.name || project.slug || 'this project'));
  }

  broadcastWorkspaceOrgChanged({ orgId, workspacePath: directoryPath });
  return { workspacePath: directoryPath, method: 'existing' };
}

// ============================================================================
// Clone
// ============================================================================

interface RunningClone {
  child: ChildProcess;
  cancelled: boolean;
}

/**
 * Remove a failed clone's leftovers, but only what the clone itself put there.
 *
 * The ownership decision is `shouldRemoveFailedCloneDestination`; everything
 * here is reading the evidence it needs from disk at the moment of cleanup,
 * rather than trusting the pre-flight existence check alone.
 */
async function cleanUpFailedClone(input: {
  destination: string;
  absentBeforeClone: boolean;
  stderr: string;
}): Promise<void> {
  const evidence: FailedCloneDestinationEvidence = {
    absentBeforeClone: input.absentBeforeClone,
    gitRefusedExistingDestination: cloneRefusedExistingDestination(input.stderr),
    isDirectoryNow: false,
    entriesNow: null,
  };
  try {
    const stats = await stat(input.destination);
    evidence.isDirectoryNow = stats.isDirectory();
    if (evidence.isDirectoryNow) evidence.entriesNow = await readdir(input.destination);
  } catch {
    // Gone or unreadable: git cleans up after itself for some failures, and
    // either way there is nothing here to take responsibility for.
  }

  if (shouldRemoveFailedCloneDestination(evidence)) {
    await rm(input.destination, { recursive: true, force: true }).catch(() => {});
    return;
  }
  if (evidence.entriesNow?.length) {
    logger.main.warn(
      '[OrgProjectWalk] Leaving the clone destination in place — its contents are not this clone\'s to remove:',
      input.destination,
    );
  }
}

const runningClones = new Map<string, RunningClone>();

export interface CloneProjectResult {
  success: boolean;
  error?: string;
  failureKind?: CloneFailureKind;
}

/**
 * Clone a project's repository into `directoryPath`.
 *
 * Terminal prompts are disabled: Nimbalyst has no credential path of its own,
 * and without this git blocks forever on a username prompt no one can see
 * instead of failing with something the walk can explain.
 */
export function cloneOrgProjectRepository(input: {
  cloneId: string;
  remoteUrl: string;
  directoryPath: string;
  onProgress?: (progress: { phase: string; percent: number | null }) => void;
}): Promise<CloneProjectResult> {
  const { cloneId, remoteUrl, directoryPath } = input;

  if (!isSafeCloneUrl(remoteUrl)) {
    return Promise.resolve({
      success: false,
      failureKind: 'unknown',
      error: 'The repository address recorded for this project is not a usable git URL.',
    });
  }
  if (runningClones.has(cloneId)) {
    return Promise.resolve({ success: false, failureKind: 'unknown', error: 'That clone is already running.' });
  }

  const absentBeforeClone = !existsSync(directoryPath);

  return new Promise<CloneProjectResult>((resolve) => {
    const child = spawn(
      'git',
      ['clone', '--progress', '--', remoteUrl, directoryPath],
      {
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
    const running: RunningClone = { child, cancelled: false };
    runningClones.set(cloneId, running);

    let stderr = '';
    child.stderr?.on('data', (data) => {
      const chunk = data.toString();
      // Bounded: git rewrites the same progress line thousands of times, and
      // the tail is all the failure classifier needs.
      stderr = (stderr + chunk).slice(-8000);
      const progress = parseCloneProgress(chunk);
      if (progress) input.onProgress?.(progress);
    });

    const finish = async (result: CloneProjectResult) => {
      runningClones.delete(cloneId);
      // The destination's `origin` just changed in whichever direction: a
      // successful clone gave a folder cached as "no remote" one, and the
      // cleanup below takes it away again. Either way the cached answer is now
      // wrong, and the walk that follows is what reads it.
      invalidateGitRemoteCache(directoryPath);
      if (!result.success) {
        // So a failed or cancelled attempt doesn't leave a half-repository that
        // the next attempt then refuses as "not empty" -- but only ever what
        // this clone itself created.
        await cleanUpFailedClone({ destination: directoryPath, absentBeforeClone, stderr });
      }
      resolve(result);
    };

    child.on('error', (err) => {
      void finish({
        success: false,
        failureKind: 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    child.on('close', (code) => {
      if (running.cancelled) {
        void finish({ success: false, failureKind: 'cancelled', error: 'Clone cancelled.' });
        return;
      }
      if (code === 0) {
        void finish({ success: true });
        return;
      }
      const failureKind = classifyCloneFailure(stderr);
      // The category is the diagnostic; git's raw text quotes the repository
      // address, which must not reach the persistent log.
      logger.main.warn('[OrgProjectWalk] Clone failed:', {
        code,
        failureKind,
        detail: redactRemoteAddresses(stderr).trim().split('\n').filter(Boolean).pop()?.slice(-200),
      });
      void finish({
        success: false,
        failureKind,
        error: stderr.trim().split('\n').filter(Boolean).pop() ?? `git clone exited with code ${code}`,
      });
    });
  });
}

export function cancelOrgProjectClone(cloneId: string): boolean {
  const running = runningClones.get(cloneId);
  if (!running) return false;
  running.cancelled = true;
  running.child.kill('SIGTERM');
  return true;
}

// ============================================================================
// IPC
// ============================================================================

export function registerOrgProjectWalkHandlers(): void {
  safeHandle('team:resolve-project-walk', async (event) => {
    try {
      // Which window is asking decides what it may still be offered, so the
      // answer is per caller rather than one app-wide verdict.
      const windowId = getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender));
      const thisWindowPath = resolveActiveWorkspacePathForWindowId(windowId) ?? null;
      return { success: true, ...(await resolveProjectWalkState(thisWindowPath)) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:inspect-project-folder', async (_event, payload: {
    orgId: string; teamProjectId: string; directoryPath: string;
  }) => {
    try {
      return { success: true, verdict: await inspectProjectFolder(payload) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:join-project-folder', async (_event, payload: {
    orgId: string; teamProjectId: string; directoryPath: string;
  }) => {
    try {
      return { success: true, ...(await joinOrgProjectWithFolder(payload)) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('team:clone-project', async (event, payload: {
    cloneId: string; remoteUrl: string; directoryPath: string;
  }) => {
    if (!payload?.cloneId || !payload.remoteUrl || !payload.directoryPath) {
      throw new Error('team:clone-project requires cloneId, remoteUrl and directoryPath');
    }
    return cloneOrgProjectRepository({
      ...payload,
      onProgress: (progress) => {
        if (event?.sender?.isDestroyed?.()) return;
        event?.sender?.send(PROJECT_CLONE_PROGRESS_CHANNEL, { cloneId: payload.cloneId, ...progress });
      },
    });
  });

  safeHandle('team:cancel-project-clone', async (_event, cloneId: string) => ({
    success: cancelOrgProjectClone(cloneId),
  }));
}
