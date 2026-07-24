/**
 * Pure access-control logic for the PR review panel: given the viewer's repo
 * capabilities (from `gh`) and a PR's state, decide which actions the UI may
 * offer. Kept side-effect-free and separate from the IPC handler so it can be
 * unit-tested without spawning `gh` or touching the database.
 */

import type { RepoCapabilities } from './GhApiService';

export interface PrPermissions {
  viewerLogin: string | null;
  canApprove: boolean;
  canMerge: boolean;
  mergeMethods: { squash: boolean; merge: boolean; rebase: boolean };
  mergeable: boolean | null;
  mergeableState: string | null;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
}

/** The PR facts the permission computation depends on. */
export interface PrPermissionInputs {
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  authorLogin: string | null;
  /** Normalized: true = mergeable, false = conflicting, null = unknown. */
  mergeable: boolean | null;
  mergeableState: string | null;
}

export function computePrPermissions(
  caps: RepoCapabilities,
  pr: PrPermissionInputs,
): PrPermissions {
  const canWrite = caps.permissions.push || caps.permissions.maintain || caps.permissions.admin;
  const isOpen = pr.state === 'open';
  const canMerge = canWrite && isOpen && !pr.isDraft;

  // Anyone with read access can submit a review, but GitHub forbids approving
  // your own PR — hide Approve when the viewer authored it.
  const isOwnPr =
    caps.viewerLogin != null && pr.authorLogin != null && caps.viewerLogin === pr.authorLogin;
  const canApprove = isOpen && caps.permissions.pull && !isOwnPr;

  let mergeMethods = {
    squash: caps.allowSquashMerge,
    merge: caps.allowMergeCommit,
    rebase: caps.allowRebaseMerge,
  };
  // Writer but no method flags resolved (rare / GitHub Enterprise): offer all
  // and let `gh` reject any the repo disallows.
  if (canMerge && !mergeMethods.squash && !mergeMethods.merge && !mergeMethods.rebase) {
    mergeMethods = { squash: true, merge: true, rebase: true };
  }

  return {
    viewerLogin: caps.viewerLogin,
    canApprove,
    canMerge,
    mergeMethods,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeableState,
    state: pr.state,
    isDraft: pr.isDraft,
  };
}
