/**
 * Artifact-side feedback backlinks: "what feedback was gathered about this?"
 *
 * One mechanism for every artifact kind. The lookup is by subject ref, so a
 * document, a tracker item, a plan (a tracker item via the frontmatter
 * projection) and any ref kind added later all resolve through the same atom
 * with no per-kind code. Hosts differ only in chrome: the shared-document
 * header hangs it off a button, the tracker item detail renders it inline.
 *
 * The section renders nothing at all when the artifact has no feedback. Most
 * documents and tracker items never will, and these are hot surfaces -- an
 * empty header, a count of zero, or a "no feedback yet" line would be noise on
 * every one of them.
 */

import React, { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { FeedbackRequestIndexEntry } from '@nimbalyst/collab-protocol';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { store } from '@nimbalyst/runtime/store';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import type { FeedbackRequestSubjectRef } from '../../../shared/feedbackRequestIndex';
import { activeCollabScopeAtom } from '../../store/atoms/collabDocuments';
import {
  feedbackRequestIndexActiveViewerAtomFamily,
  feedbackRequestIndexBySubjectAtomFamily,
  feedbackRequestIndexSubjectKey,
  feedbackRequestIndexTargetKey,
} from '../../store/atoms/feedbackRequests';
import { selectedWorkstreamAtom } from '../../store/atoms/sessions';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import {
  feedbackBacklinkAuthorLabel,
  feedbackBacklinkProgressLabel,
  feedbackBacklinkStatus,
  sortFeedbackBacklinks,
  type FeedbackBacklinkTone,
} from './feedbackBacklinkModel';
import { openFeedbackRequestResults } from './feedbackRequestTab';

const TONE_CLASS: Record<FeedbackBacklinkTone, string> = {
  open: 'text-[var(--nim-primary)] border-[var(--nim-primary)]',
  answered: 'text-[var(--nim-success)] border-[var(--nim-success)]',
  closed: 'text-[var(--nim-text-faint)] border-[var(--nim-border)]',
};

export interface FeedbackBacklinks {
  /** Requests about this artifact, most recently active first. */
  entries: FeedbackRequestIndexEntry[];
  teamMemberId: TeamMemberId | '';
  open: (entry: FeedbackRequestIndexEntry) => void;
}

/**
 * The index is keyed by the collab scope that synced it, so the scope -- not a
 * host-supplied workspace path -- is what makes the lookup line up with what
 * the team room wrote. Reading it here also means a surface mounted before the
 * connection resolves picks the entries up when it does.
 */
export function useFeedbackBacklinks(
  subject: FeedbackRequestSubjectRef | null,
): FeedbackBacklinks {
  const scope = useAtomValue(activeCollabScopeAtom);
  const workspacePath = scope?.scopeKey ?? '';
  const orgId = scope?.orgId ?? '';
  const kind = subject?.kind ?? 'document';
  const sourceId = subject?.sourceId ?? '';

  const subjectKey = useMemo(
    () => feedbackRequestIndexSubjectKey({ workspacePath, orgId }, { kind, sourceId }),
    [workspacePath, orgId, kind, sourceId],
  );
  const targetKey = useMemo(
    () => feedbackRequestIndexTargetKey({ workspacePath, orgId }),
    [workspacePath, orgId],
  );

  const matches = useAtomValue(feedbackRequestIndexBySubjectAtomFamily(subjectKey));
  const teamMemberId = useAtomValue(feedbackRequestIndexActiveViewerAtomFamily(targetKey));

  const entries = useMemo(
    () => (sourceId && workspacePath ? sortFeedbackBacklinks(matches) : []),
    [matches, sourceId, workspacePath],
  );

  const open = useCallback((entry: FeedbackRequestIndexEntry) => {
    // The results tab lives in the workstream tab strip, so opening needs a
    // mounted workstream. Read at click time rather than subscribing: this
    // section sits on surfaces that re-render on every selection change.
    const selection = workspacePath
      ? store.get(selectedWorkstreamAtom(workspacePath))
      : null;
    if (!selection?.id) return;
    openFeedbackRequestResults({
      workstreamId: selection.id,
      orgId: entry.orgId,
      requestId: entry.requestId,
    });
  }, [workspacePath]);

  return { entries, teamMemberId, open };
}

interface FeedbackBacklinkRowsProps {
  entries: FeedbackRequestIndexEntry[];
  teamMemberId: TeamMemberId | '';
  onOpen: (entry: FeedbackRequestIndexEntry) => void;
}

const FeedbackBacklinkRows: React.FC<FeedbackBacklinkRowsProps> = ({
  entries,
  teamMemberId,
  onOpen,
}) => (
  <div className="feedback-backlink-rows space-y-0.5">
    {entries.map((entry) => {
      const status = feedbackBacklinkStatus(entry);
      const author = feedbackBacklinkAuthorLabel(entry, teamMemberId);
      return (
        <button
          key={entry.requestId}
          className="feedback-backlink-entry w-full flex items-start gap-2 px-2 py-1.5 rounded text-left border-none bg-transparent cursor-pointer transition-colors hover:bg-[var(--nim-bg-hover)]"
          onClick={() => onOpen(entry)}
          title={entry.title}
        >
          <MaterialSymbol
            icon="reviews"
            size={13}
            className="mt-[2px] shrink-0 text-[var(--nim-text-faint)]"
          />
          <span className="min-w-0 flex-1">
            <span className="feedback-backlink-title block truncate text-xs text-[var(--nim-text)]">
              {entry.title}
            </span>
            <span className="feedback-backlink-meta mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--nim-text-faint)]">
              <span
                className={`feedback-backlink-status rounded border px-1 py-[1px] uppercase tracking-wide ${TONE_CLASS[status.tone]}`}
              >
                {status.label}
              </span>
              <span>{feedbackBacklinkProgressLabel(entry)}</span>
              {author && <span>{author}</span>}
              <span>{getRelativeTimeString(entry.updatedAt)}</span>
            </span>
          </span>
        </button>
      );
    })}
  </div>
);

export interface FeedbackBacklinkSectionProps {
  /** The artifact this surface is showing, or null while it is unresolved. */
  subject: FeedbackRequestSubjectRef | null;
  className?: string;
}

/**
 * The inline section, for hosts that lay their metadata out in stacked
 * sections (the tracker item detail).
 */
export const FeedbackBacklinkSection: React.FC<FeedbackBacklinkSectionProps> = ({
  subject,
  className,
}) => {
  const { entries, teamMemberId, open } = useFeedbackBacklinks(subject);
  if (entries.length === 0) return null;

  return (
    <div className={`feedback-backlink-section space-y-2 ${className ?? ''}`}>
      <div className="feedback-backlink-header flex items-center gap-1.5">
        <h4 className="text-xs font-medium text-nim-muted uppercase tracking-wide">
          Feedback
        </h4>
        <span className="feedback-backlink-count rounded bg-[var(--nim-bg-tertiary)] px-1 text-[10px] text-[var(--nim-text-faint)]">
          {entries.length}
        </span>
      </div>
      <FeedbackBacklinkRows entries={entries} teamMemberId={teamMemberId} onOpen={open} />
    </div>
  );
};

/**
 * The header affordance, for hosts whose artifact info lives behind a toolbar
 * button (the shared-document header). The button itself only exists when the
 * document has feedback, so a header with nothing to show is untouched.
 */
export const FeedbackBacklinkHeaderButton: React.FC<FeedbackBacklinkSectionProps> = ({
  subject,
}) => {
  const { entries, teamMemberId, open } = useFeedbackBacklinks(subject);
  const menu = useFloatingMenu({ placement: 'bottom-end' });

  const handleOpen = useCallback((entry: FeedbackRequestIndexEntry) => {
    menu.setIsOpen(false);
    open(entry);
  }, [menu, open]);

  if (entries.length === 0) return null;

  return (
    <div className="feedback-backlink-header-button unified-header-dropdown-container relative">
      <button
        ref={menu.refs.setReference}
        className={`unified-header-button nim-btn-icon w-7 h-7 rounded border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-150 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${
          menu.isOpen ? 'active bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]' : ''
        }`}
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        title={`Feedback about this document (${entries.length})`}
        {...menu.getReferenceProps()}
      >
        <MaterialSymbol icon="reviews" size={16} />
      </button>

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            className="feedback-backlink-popover min-w-[300px] max-w-[380px] overflow-auto rounded-md z-[1000] p-2 bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
            {...menu.getFloatingProps()}
          >
            <div className="feedback-backlink-header mb-1 flex items-center gap-1.5 px-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-faint)]">
                Feedback
              </span>
              <span className="feedback-backlink-count rounded bg-[var(--nim-bg-tertiary)] px-1 text-[10px] text-[var(--nim-text-faint)]">
                {entries.length}
              </span>
            </div>
            <FeedbackBacklinkRows
              entries={entries}
              teamMemberId={teamMemberId}
              onOpen={handleOpen}
            />
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};
