import { describe, it, expect } from 'vitest';
import { computePrPermissions, type PrPermissionInputs } from '../prPermissions';
import type { RepoCapabilities } from '../GhApiService';

function caps(overrides: Partial<RepoCapabilities> = {}): RepoCapabilities {
  return {
    viewerLogin: 'octocat',
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    allowSquashMerge: true,
    allowMergeCommit: true,
    allowRebaseMerge: true,
    deleteBranchOnMerge: false,
    ...overrides,
  };
}

function pr(overrides: Partial<PrPermissionInputs> = {}): PrPermissionInputs {
  return {
    state: 'open',
    isDraft: false,
    authorLogin: 'someone-else',
    mergeable: true,
    mergeableState: 'clean',
    ...overrides,
  };
}

describe('computePrPermissions', () => {
  it('hides merge for read-only access', () => {
    const result = computePrPermissions(caps({ permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } }), pr());
    expect(result.canMerge).toBe(false);
  });

  it('allows merge with push access on an open, non-draft PR', () => {
    const result = computePrPermissions(
      caps({ permissions: { admin: false, maintain: false, push: true, triage: false, pull: true } }),
      pr(),
    );
    expect(result.canMerge).toBe(true);
  });

  it('allows merge with maintain or admin access', () => {
    const maintain = computePrPermissions(
      caps({ permissions: { admin: false, maintain: true, push: false, triage: false, pull: true } }),
      pr(),
    );
    const admin = computePrPermissions(
      caps({ permissions: { admin: true, maintain: false, push: false, triage: false, pull: true } }),
      pr(),
    );
    expect(maintain.canMerge).toBe(true);
    expect(admin.canMerge).toBe(true);
  });

  it('forbids merge on a draft PR even with write access', () => {
    const result = computePrPermissions(
      caps({ permissions: { admin: false, maintain: false, push: true, triage: false, pull: true } }),
      pr({ isDraft: true }),
    );
    expect(result.canMerge).toBe(false);
  });

  it('forbids merge on a closed/merged PR', () => {
    const write = { admin: false, maintain: false, push: true, triage: false, pull: true };
    expect(computePrPermissions(caps({ permissions: write }), pr({ state: 'closed' })).canMerge).toBe(false);
    expect(computePrPermissions(caps({ permissions: write }), pr({ state: 'merged' })).canMerge).toBe(false);
  });

  it('hides Approve on your own PR (GitHub forbids self-approval)', () => {
    const result = computePrPermissions(caps({ viewerLogin: 'octocat' }), pr({ authorLogin: 'octocat' }));
    expect(result.canApprove).toBe(false);
  });

  it('allows Approve on someone else’s open PR with read access', () => {
    const result = computePrPermissions(caps({ viewerLogin: 'octocat' }), pr({ authorLogin: 'other' }));
    expect(result.canApprove).toBe(true);
  });

  it('hides Approve on a closed PR', () => {
    const result = computePrPermissions(caps(), pr({ state: 'closed' }));
    expect(result.canApprove).toBe(false);
  });

  it('exposes only the merge methods the repo allows', () => {
    const result = computePrPermissions(
      caps({
        permissions: { admin: false, maintain: false, push: true, triage: false, pull: true },
        allowSquashMerge: true,
        allowMergeCommit: false,
        allowRebaseMerge: false,
      }),
      pr(),
    );
    expect(result.mergeMethods).toEqual({ squash: true, merge: false, rebase: false });
  });

  it('falls back to offering all methods when a writer has no flags resolved', () => {
    const result = computePrPermissions(
      caps({
        permissions: { admin: false, maintain: false, push: true, triage: false, pull: true },
        allowSquashMerge: false,
        allowMergeCommit: false,
        allowRebaseMerge: false,
      }),
      pr(),
    );
    expect(result.mergeMethods).toEqual({ squash: true, merge: true, rebase: true });
  });

  it('passes through normalized mergeable / mergeableState', () => {
    const conflicting = computePrPermissions(caps(), pr({ mergeable: false, mergeableState: 'dirty' }));
    expect(conflicting.mergeable).toBe(false);
    expect(conflicting.mergeableState).toBe('dirty');
  });
});
