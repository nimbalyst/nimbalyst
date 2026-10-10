/**
 * A Pages section's Trash: each page sent there, who sent it and when, and
 * Restore. Restore brings back the pages that went with it; a page whose
 * parent is gone lands at the section root, and the dialog says so.
 *
 * There is no permanent delete here. Team Trash empties itself 30 days after a
 * page went in; Personal Trash keeps a page until it is restored.
 * Lazy-loaded by `CollabSidebarTrashEntry`.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { isPersonalCollabScope } from '@nimbalyst/collab-client/core';
import { pageDisplayName, type SharedDocument } from '@nimbalyst/collab-client/docs';
import { listTrashEntries, restoredParentGone, pagesTrashedWith } from '../docs/collabTrash';
import { useCollabDocsUI } from './CollabDocsUIProvider';
import { resolveSharedDocumentTypePresentation } from './documentPresentation';
import { FloatingPortal } from '../ui-primitives/useFloatingMenu';
import { getRelativeTimeString } from './time';

const nameOf = (document: SharedDocument) => pageDisplayName(document.title, document.documentType) || 'Untitled';

/** Team member id to display name; empty for Personal, which has no members. */
function useMemberNames(orgId: string | null): Map<string, string> {
  const { host } = useCollabDocsUI();
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    const load = () => host.getMembers(orgId).then((members) => {
      if (cancelled) return;
      setNames(new Map(members.flatMap((member) => {
        const name = member.name || member.email;
        return name ? [[String(member.memberId), name] as [string, string]] : [];
      })));
    }, (error) => console.warn('[CollabTrashDialog] Failed to load the team member directory:', error));
    void load();
    const unsubscribe = host.onMembersChanged?.(() => { void load(); });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host, orgId]);
  return names;
}

export interface CollabTrashDialogProps {
  /** The section's name ("Team", "Personal"), also the root a page may go back to. */
  sectionLabel: string;
  onClose: () => void;
}

export default function CollabTrashDialog({ sectionLabel, onClose }: CollabTrashDialogProps) {
  const { scope, host, session } = useCollabDocsUI();
  const personal = isPersonalCollabScope(scope);
  const all = useAtomValue(session.atoms.allSharedDocuments);
  const trashed = useAtomValue(session.atoms.trashedSharedDocuments);
  const syncStatus = useAtomValue(session.atoms.syncStatus);
  const entries = useMemo(() => listTrashEntries(trashed), [trashed]);
  const members = useMemberNames(personal ? null : scope.orgId);
  const descriptors = host.documents?.documentTypes() ?? [];
  const [restoring, setRestoring] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  // Team restores go through the server; Personal ones are local.
  const canRestore = personal || syncStatus === 'connected';

  const restore = async (document: SharedDocument) => {
    const name = nameOf(document);
    setRestoring(document.documentId);
    setNotice(null);
    const result = await session.restoreDocument(document.documentId);
    setRestoring(null);
    if (!result.ok) {
      setNotice({ error: true, text: `Could not restore "${name}": ${result.error}` });
      return;
    }
    const inside = result.restored - 1;
    const withInside = inside > 0 ? ` and ${inside} page${inside === 1 ? '' : 's'} inside it` : '';
    setNotice({
      error: false,
      text: result.movedToRoot
        ? `Restored "${name}"${withInside} to the top of ${sectionLabel}: the page it was under is no longer in the tree.`
        : `Restored "${name}"${withInside}.`,
    });
  };

  return (
    <FloatingPortal>
      <div
        className="collab-trash-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
        onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      >
        <div
          className="collab-trash-dialog @container w-[560px] max-w-[92%] max-h-[80vh] flex flex-col bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl shadow-2xl overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`${sectionLabel} Trash`}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-[var(--nim-border)]">
            <div className="flex-1 min-w-0">
              <h2 className="m-0 text-[14px] font-semibold text-[var(--nim-text)]">{sectionLabel} Trash</h2>
              <p className="mt-0.5 mb-0 text-[12px] text-[var(--nim-text-faint)]">
                {personal
                  ? 'Pages stay here until you restore them.'
                  : 'Pages are deleted for good 30 days after they go to Trash.'}
                {' '}Restore puts a page back where it was, with the pages inside it.
              </p>
            </div>
            <button
              type="button"
              className="collab-trash-close shrink-0 p-1 rounded border-none bg-transparent cursor-pointer text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              aria-label="Close"
              autoFocus
              onClick={onClose}
            >
              <MaterialSymbol icon="close" size={18} />
            </button>
          </div>

          {notice && (
            <div
              className={`collab-trash-notice mx-5 mt-3 px-3 py-2 rounded-md text-[12px] select-text ${
                notice.error
                  ? 'text-[var(--nim-error)] bg-[color-mix(in_srgb,var(--nim-error)_10%,transparent)]'
                  : 'text-[var(--nim-text)] bg-[var(--nim-bg-secondary)]'
              }`}
              role="status"
            >
              {notice.text}
            </div>
          )}

          <div className="nim-scrollbar flex-1 min-h-0 overflow-y-auto m-4 select-text">
            {entries.length === 0 ? (
              <div className="collab-trash-empty rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-5 py-8 text-center">
                <MaterialSymbol icon="delete" size={28} className="text-[var(--nim-text-faint)]" />
                <p className="mt-2 mb-0 text-[13px] text-[var(--nim-text-muted)]">Trash is empty.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] divide-y divide-[var(--nim-border)]">
                {entries.map(({ document, insideCount }) => {
                  const by = personal ? undefined : members.get(document.lastWriterUserId ?? '');
                  const parentGone = restoredParentGone(all, document.documentId, new Set(pagesTrashedWith(all, document.documentId)));
                  const parent = !parentGone && document.parentFolderId && document.parentKind !== 'item'
                    ? all.find((candidate) => candidate.documentId === document.parentFolderId)
                    : undefined;
                  return (
                    <div
                      key={document.documentId}
                      className="collab-trash-row flex flex-col gap-2 px-3 py-2.5 @[420px]:flex-row @[420px]:items-center @[420px]:gap-3"
                      data-trash-document-id={document.documentId}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <MaterialSymbol
                          icon={resolveSharedDocumentTypePresentation(document, descriptors).icon}
                          size={18}
                          className="shrink-0 text-[var(--nim-text-muted)]"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-[13px] text-[var(--nim-text)]">{nameOf(document)}</div>
                          <div className="text-[11.5px] text-[var(--nim-text-faint)]">
                            Trashed {getRelativeTimeString(document.trashedAt ?? Date.now())}
                            {by ? ` by ${by}` : ''}
                            {insideCount > 0 ? ` · ${insideCount} page${insideCount === 1 ? '' : 's'} inside` : ''}
                          </div>
                          {(parent || parentGone) && (
                            <div className="truncate text-[11.5px] text-[var(--nim-text-faint)]">
                              {parent ? `Was in ${nameOf(parent)}` : `Its page is gone; restores to the top of ${sectionLabel}`}
                            </div>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="collab-trash-restore shrink-0 self-start @[420px]:self-center px-2.5 py-1 rounded border border-[var(--nim-border)] bg-transparent text-[12px] text-[var(--nim-text)] cursor-pointer hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={!canRestore || restoring !== null}
                        title={canRestore ? undefined : 'Reconnect to restore'}
                        onClick={() => void restore(document)}
                      >
                        {restoring === document.documentId ? 'Restoring...' : 'Restore'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </FloatingPortal>
  );
}
