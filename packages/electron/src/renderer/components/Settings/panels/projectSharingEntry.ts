/**
 * Entry-state selection for the project sharing flow.
 *
 * The old panel stacked create-org, add-to-existing-org and accept-invite on top
 * of each other and let the user work out which one applied. This picks exactly
 * one starting point instead, and reports the git-remote precondition separately
 * so the UI can explain it rather than silently hiding an option.
 *
 * Pure — no IPC, no atoms. Tested in `__tests__/projectSharingEntry.test.ts`.
 */

export interface ProjectSharingInvite {
  orgId: string;
  name: string;
  membershipType?: string;
}

export interface ProjectSharingOrgOption {
  orgId: string;
  name: string;
}

export type ProjectSharingEntryState =
  /** An invitation is waiting; it outranks every other choice. */
  | 'invite-pending'
  /** The user owns/administers at least one org: add here, or start a new one. */
  | 'choose-existing-or-new'
  /** No org to join yet, so creating one is the only meaningful move. */
  | 'create-first-organization';

export interface ProjectSharingEntry {
  state: ProjectSharingEntryState;
  /**
   * True when the workspace has no git remote. Sharing keys a project by its
   * remote, so the flow says so plainly — the options stay visible.
   */
  needsGitRemote: boolean;
  invite?: ProjectSharingInvite;
}

export function selectProjectSharingEntry(input: {
  pendingInvite?: ProjectSharingInvite | null;
  gitRemote?: string | null;
  adminOrgs?: ProjectSharingOrgOption[];
}): ProjectSharingEntry {
  const needsGitRemote = !input.gitRemote;

  if (input.pendingInvite) {
    return { state: 'invite-pending', needsGitRemote, invite: input.pendingInvite };
  }

  return {
    state: (input.adminOrgs?.length ?? 0) > 0 ? 'choose-existing-or-new' : 'create-first-organization',
    needsGitRemote,
  };
}
