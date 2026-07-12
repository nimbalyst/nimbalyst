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
import { PullRequestActionError } from './PullRequestActionError';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingMethod, setPendingMethod] = useState<MergeMethod | null>(null);
  const [editMethod, setEditMethod] = useState<MergeMethod>('squash');
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');

  const methodMenu = useFloatingMenu({ placement: 'bottom-end' });
  const editMenu = useFloatingMenu({ placement: 'bottom-end' });

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
  // GitHub only honors a custom commit message for squash / merge-commit.
  const editableMethods = allowedMethods.filter((m) => m !== 'rebase');

  const openEditor = useCallback(() => {
    methodMenu.setIsOpen(false);
    setEditMethod(editableMethods.some((m) => m === defaultMethod) ? defaultMethod : editableMethods[0] ?? 'squash');
    setEditTitle(`${pr.title} (#${pr.number})`);
    setEditBody(pr.body ?? '');
    editMenu.setIsOpen(true);
  }, [methodMenu, editMenu, editableMethods, defaultMethod, pr.title, pr.number, pr.body]);

  const handleApprove = useCallback(async () => {
    setBusy('approve');
    setError(null);
    setNotice(null);
    try {
      await getPullRequestService().approve(workspaceId, remote, pr.number);
      setNotice('Approved');
      onActed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBusy(null);
    }
  }, [workspaceId, remote, pr.number, onActed]);

  const handleMerge = useCallback(
    async (method: MergeMethod, commitTitle?: string, commitMessage?: string) => {
      setBusy('merge');
      setError(null);
      setNotice(null);
      setPendingMethod(null);
      try {
        const res = await getPullRequestService().merge(
          workspaceId,
          remote,
          pr.number,
          method,
          commitTitle,
          commitMessage,
        );
        setNotice(res.merged ? `Merged (${METHOD_LABEL[method].toLowerCase()})` : 'Merge requested');
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
        {notice ?? 'Merged'}
      </span>
    );
  }

  const showApprove = perms.canApprove;
  const showMerge = perms.canMerge && allowedMethods.length > 0;
  if (!showApprove && !showMerge) {
    if (notice) {
      return <span className="text-nim-success text-[11px] flex items-center gap-1" data-testid="pr-action-notice"><MaterialSymbol icon="check_circle" size={13} />{notice}</span>;
    }
    return error ? <PullRequestActionError error={error} /> : null;
  }

  const mergeBlocked = perms.mergeable === false;
  const mergeTitle = mergeBlocked
    ? 'Resolve conflicts before merging'
    : perms.mergeableState === 'blocked'
      ? 'Branch protection may block this merge'
      : `Merge #${pr.number} into ${pr.baseRef}`;

  return (
    <div className="pr-actions flex items-center gap-2" data-testid="pr-actions">
      {error && <PullRequestActionError error={error} />}
      {notice && !error && (
        <span className="text-nim-success text-[11px] flex items-center gap-1" data-testid="pr-action-notice">
          <MaterialSymbol icon="check_circle" size={13} />
          {notice}
        </span>
      )}

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
            ref={editMenu.refs.setReference}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover rounded-l rounded-r-none transition-colors disabled:opacity-50"
            onClick={() => setPendingMethod(defaultMethod)}
            disabled={busy !== null || mergeBlocked}
            data-testid="pr-merge-button"
            title={mergeTitle}
          >
            <MaterialSymbol icon={busy === 'merge' ? 'hourglass_empty' : 'merge'} size={14} />
            {METHOD_LABEL[defaultMethod]}
          </button>
          <button
            ref={methodMenu.refs.setReference}
            {...methodMenu.getReferenceProps()}
            onClick={() => methodMenu.setIsOpen(!methodMenu.isOpen)}
            disabled={busy !== null || mergeBlocked}
            className="flex items-center px-1 bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover rounded-r border-l border-[var(--nim-on-primary)]/20 transition-colors disabled:opacity-50"
            data-testid="pr-merge-method-button"
            title="More merge options"
          >
            <MaterialSymbol icon="expand_more" size={14} />
          </button>
          {methodMenu.isOpen && (
            <FloatingPortal>
              <div
                ref={methodMenu.refs.setFloating}
                style={methodMenu.floatingStyles}
                {...methodMenu.getFloatingProps()}
                className="z-50 min-w-[200px] bg-nim-secondary border border-nim rounded-md shadow-lg py-1"
              >
                {allowedMethods.length > 1 &&
                  allowedMethods.map((m) => (
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
                {editableMethods.length > 0 && (
                  <>
                    {allowedMethods.length > 1 && <div className="my-1 border-t border-nim" />}
                    <button
                      className="w-full text-left px-3 py-1.5 text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim transition-colors flex items-center gap-2"
                      onClick={openEditor}
                      data-testid="pr-merge-edit-message"
                    >
                      <MaterialSymbol icon="edit" size={13} />
                      Edit commit message…
                    </button>
                  </>
                )}
              </div>
            </FloatingPortal>
          )}
          {editMenu.isOpen && (
            <FloatingPortal>
              <div
                ref={editMenu.refs.setFloating}
                style={editMenu.floatingStyles}
                {...editMenu.getFloatingProps()}
                className="z-50 w-[440px] max-w-[90vw] bg-nim-secondary border border-nim rounded-md shadow-lg p-3 flex flex-col gap-2"
                data-testid="pr-merge-edit-popover"
              >
                <div className="text-[11px] font-semibold uppercase tracking-wide text-nim-faint">
                  Edit commit message
                </div>
                {editableMethods.length > 1 && (
                  <div className="flex gap-1">
                    {editableMethods.map((m) => (
                      <button
                        key={m}
                        onClick={() => setEditMethod(m)}
                        className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                          editMethod === m
                            ? 'border-[var(--nim-primary)] text-nim'
                            : 'border-nim text-nim-muted hover:text-nim'
                        }`}
                      >
                        {METHOD_LABEL[m]}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  className="nim-input text-sm"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Commit title"
                  data-testid="pr-merge-edit-title"
                />
                <textarea
                  className="nim-input text-sm font-mono min-h-[120px] resize-y"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  placeholder="Commit message (optional)"
                  data-testid="pr-merge-edit-body"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    className="px-2 py-1 text-xs text-nim-muted hover:text-nim border border-nim rounded transition-colors"
                    onClick={() => editMenu.setIsOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover rounded transition-colors disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => {
                      editMenu.setIsOpen(false);
                      void handleMerge(editMethod, editTitle, editBody);
                    }}
                    data-testid="pr-merge-edit-confirm"
                  >
                    <MaterialSymbol icon="merge" size={14} />
                    {METHOD_LABEL[editMethod]}
                  </button>
                </div>
              </div>
            </FloatingPortal>
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
