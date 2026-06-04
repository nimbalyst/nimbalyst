/**
 * PullRequestActions — Approve + Merge controls for the PR detail header.
 *
 * Every button is gated by `pr:permissions`, which derives the viewer's
 * actual access from `gh` (repo permissions + the repo's allowed merge
 * methods + PR state). A user who can't approve or can't merge never sees
 * the button. The merge itself is irreversible, so it goes through an
 * explicit in-app confirm step (no silent one-click merge).
 */

import { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import {
  getPullRequestService,
  type PullRequestRow,
  type PullRequestPermissions,
  type MergeMethod,
} from '../../services/RendererPullRequestService';

interface PullRequestActionsProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  /** Bumps on the detail-level poll; re-loads permissions when it changes. */
  refreshToken: number;
  /** Called after a successful approve/merge so the parent re-fetches tabs. */
  onActed: () => void;
}

const METHOD_ORDER: MergeMethod[] = ['squash', 'merge', 'rebase'];
const METHOD_LABEL: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

export function PullRequestActions({
  workspaceId,
  remote,
  pr,
  refreshToken,
  onActed,
}: PullRequestActionsProps): JSX.Element | null {
  const [perms, setPerms] = useState<PullRequestPermissions | null>(null);
  const [busy, setBusy] = useState<'approve' | 'merge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingMethod, setPendingMethod] = useState<MergeMethod | null>(null);

  const methodMenu = useFloatingMenu({ placement: 'bottom-end' });

  useEffect(() => {
    let cancelled = false;
    getPullRequestService()
      .permissions(workspaceId, remote, pr.number)
      .then((p) => {
        if (!cancelled) setPerms(p);
      })
      .catch(() => {
        // Permission probe failures shouldn't break the detail view; just
        // hide the action buttons.
        if (!cancelled) setPerms(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.number, refreshToken]);

  const allowedMethods = perms
    ? METHOD_ORDER.filter((m) => perms.mergeMethods[m])
    : [];
  const defaultMethod = allowedMethods[0] ?? 'squash';

  const handleApprove = useCallback(async () => {
    setBusy('approve');
    setError(null);
    try {
      await getPullRequestService().approve(workspaceId, remote, pr.number);
      onActed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBusy(null);
    }
  }, [workspaceId, remote, pr.number, onActed]);

  const handleMerge = useCallback(
    async (method: MergeMethod) => {
      setBusy('merge');
      setError(null);
      setPendingMethod(null);
      try {
        await getPullRequestService().merge(workspaceId, remote, pr.number, method);
        onActed();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Merge failed');
      } finally {
        setBusy(null);
      }
    },
    [workspaceId, remote, pr.number, onActed],
  );

  if (!perms) return null;

  // Already merged — show a badge instead of actions.
  if (perms.state === 'merged') {
    return (
      <span
        className="flex items-center gap-1 px-2 py-1 text-xs text-nim-on-primary bg-[var(--nim-primary)] rounded"
        data-testid="pr-merged-badge"
      >
        <MaterialSymbol icon="merge" size={14} />
        Merged
      </span>
    );
  }

  const showApprove = perms.canApprove;
  const showMerge = perms.canMerge && allowedMethods.length > 0;
  if (!showApprove && !showMerge) {
    return error ? <span className="text-nim-error text-[11px]">{error}</span> : null;
  }

  const mergeBlocked = perms.mergeable === false;
  const mergeTitle = mergeBlocked
    ? 'Resolve conflicts before merging'
    : perms.mergeableState === 'blocked'
      ? 'Branch protection may block this merge'
      : `Merge #${pr.number} into ${pr.baseRef}`;

  return (
    <div className="pr-actions flex items-center gap-2" data-testid="pr-actions">
      {error && <span className="text-nim-error text-[11px] max-w-[220px] truncate" title={error}>{error}</span>}

      {showApprove && (
        <button
          className="flex items-center gap-1 px-2 py-1 text-xs text-nim-muted hover:text-nim border border-nim rounded transition-colors disabled:opacity-50"
          onClick={handleApprove}
          disabled={busy !== null}
          data-testid="pr-approve-button"
          title={`Approve #${pr.number}`}
        >
          <MaterialSymbol icon={busy === 'approve' ? 'hourglass_empty' : 'check_circle'} size={14} />
          Approve
        </button>
      )}

      {showMerge && pendingMethod === null && (
        <div className="flex items-stretch">
          <button
            className="flex items-center gap-1 px-2 py-1 text-xs bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover rounded-l rounded-r-none transition-colors disabled:opacity-50"
            onClick={() => setPendingMethod(defaultMethod)}
            disabled={busy !== null || mergeBlocked}
            data-testid="pr-merge-button"
            title={mergeTitle}
          >
            <MaterialSymbol icon={busy === 'merge' ? 'hourglass_empty' : 'merge'} size={14} />
            {METHOD_LABEL[defaultMethod]}
          </button>
          {allowedMethods.length > 1 && (
            <>
              <button
                ref={methodMenu.refs.setReference}
                {...methodMenu.getReferenceProps()}
                onClick={() => methodMenu.setIsOpen(!methodMenu.isOpen)}
                disabled={busy !== null || mergeBlocked}
                className="flex items-center px-1 bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover rounded-r border-l border-[var(--nim-on-primary)]/20 transition-colors disabled:opacity-50"
                data-testid="pr-merge-method-button"
                title="Choose merge method"
              >
                <MaterialSymbol icon="expand_more" size={14} />
              </button>
              {methodMenu.isOpen && (
                <FloatingPortal>
                  <div
                    ref={methodMenu.refs.setFloating}
                    style={methodMenu.floatingStyles}
                    {...methodMenu.getFloatingProps()}
                    className="z-50 min-w-[180px] bg-nim-secondary border border-nim rounded-md shadow-lg py-1"
                  >
                    {allowedMethods.map((m) => (
                      <button
                        key={m}
                        className="w-full text-left px-3 py-1.5 text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim transition-colors"
                        onClick={() => {
                          methodMenu.setIsOpen(false);
                          setPendingMethod(m);
                        }}
                      >
                        {METHOD_LABEL[m]}
                      </button>
                    ))}
                  </div>
                </FloatingPortal>
              )}
            </>
          )}
        </div>
      )}

      {showMerge && pendingMethod !== null && (
        <div className="flex items-center gap-1.5" data-testid="pr-merge-confirm">
          <span className="text-[11px] text-nim-muted">
            {METHOD_LABEL[pendingMethod]} into <span className="font-mono text-nim">{pr.baseRef}</span>?
          </span>
          <button
            className="flex items-center gap-1 px-2 py-1 text-xs bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover rounded transition-colors disabled:opacity-50"
            onClick={() => handleMerge(pendingMethod)}
            disabled={busy !== null}
            data-testid="pr-merge-confirm-button"
          >
            <MaterialSymbol icon={busy === 'merge' ? 'hourglass_empty' : 'check'} size={14} />
            Confirm
          </button>
          <button
            className="px-2 py-1 text-xs text-nim-muted hover:text-nim border border-nim rounded transition-colors"
            onClick={() => setPendingMethod(null)}
            disabled={busy !== null}
            data-testid="pr-merge-cancel-button"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
