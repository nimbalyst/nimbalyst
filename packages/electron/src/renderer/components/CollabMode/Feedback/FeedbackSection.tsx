import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useAtomValue } from 'jotai';

import {
  feedbackRequestIndexActiveViewerAtomFamily,
  feedbackRequestIndexListAtomFamily,
  feedbackRequestIndexTargetKey,
} from '../../../store/atoms/feedbackRequests';
import type { FeedbackRequestIndexTarget } from '../../../../shared/feedbackRequestIndex';
import { useOrgRoster } from '../../../hooks/useOrgRoster';
import { FeedbackRequestSurface } from '../../FeedbackRequest/FeedbackRequestSurface';
import { FeedbackRow } from './FeedbackRow';
import {
  FEEDBACK_LIST_FILTERS,
  selectFeedbackRows,
  toFeedbackRowView,
  type FeedbackListFilterId,
} from './feedbackListModel';

/** How often relative timestamps re-render in the absence of any data change. */
const RELATIVE_LABEL_TICK_MS = 60_000;

/**
 * Asks the main process to re-emit this org's index.
 *
 * The rows themselves arrive the way every other synced list does — main pushes
 * `feedback-request-index:changed`, the central listener writes the atoms, this
 * surface reads them. This only prompts that push, because a window that opened
 * after the last sync event has nothing in its atoms until something moves.
 */
function primeFeedbackRequestIndex(target: FeedbackRequestIndexTarget): void {
  void window.electronAPI.invoke('feedback-request-index:list', target)
    .catch((error: unknown) => {
      console.error('[FeedbackSection] Could not read the feedback index:', error);
    });
}

/**
 * The shared area's feedback surface: every request this member is party to.
 *
 * A request is a resource, not a message, and until now it only existed as one
 * dismissible inbox delivery (recipient) or one closable results tab (author).
 * This is where it stays findable afterwards — open, answered and closed — and
 * where opening one lands on the same rich request UI it was delivered in.
 *
 * It lives beside the shared documents because that is what the feedback is
 * usually about; the organization window's Inbox remains the delivery path.
 *
 * The list is the org-scoped index, which the server already filtered to the
 * viewer's participation. Nothing here re-implements that gate; a request this
 * member cannot see never reaches the atom.
 */
export function FeedbackSection({
  orgId,
  workspacePath,
  now: nowProp,
}: {
  orgId: string;
  /**
   * The project whose team JWT backs the index. Absent only before the
   * collaboration scope resolves — the surface says so rather than showing an
   * empty list that reads as "you have no feedback".
   */
  workspacePath?: string;
  /** Deterministic clock seam for relative-label tests. */
  now?: number;
}) {
  const [filter, setFilter] = useState<FeedbackListFilterId>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const target = useMemo<FeedbackRequestIndexTarget>(
    () => ({ workspacePath: workspacePath ?? '', orgId }),
    [orgId, workspacePath],
  );
  const targetKey = useMemo(
    () => feedbackRequestIndexTargetKey(target),
    [target],
  );
  const entries = useAtomValue(feedbackRequestIndexListAtomFamily(targetKey));
  // The team-room identity main verified for this index. Filters are asked
  // against it rather than against a roster lookup, so "sent by me" can never
  // disagree with the participation filter that produced these rows.
  const viewerUserId = useAtomValue(
    feedbackRequestIndexActiveViewerAtomFamily(targetKey),
  );
  // Names only: the index carries an author as an org member id, and the row
  // has to say who asked. Identity for the filters still comes from the index's
  // own verified viewer above, never from this roster.
  const { memberNames } = useOrgRoster(orgId);

  useEffect(() => {
    if (!workspacePath) return;
    primeFeedbackRequestIndex(target);
  }, [target, workspacePath]);

  useEffect(() => {
    if (nowProp !== undefined) return;
    const timer = setInterval(() => setTick((value) => value + 1), RELATIVE_LABEL_TICK_MS);
    return () => clearInterval(timer);
  }, [nowProp]);

  // Frozen per render pass so labels stay put while the user types.
  const now = useMemo(() => nowProp ?? Date.now(), [nowProp, entries, tick]);

  const { entries: visible, counts } = useMemo(
    () => selectFeedbackRows({ entries, filter, query, viewerUserId }),
    [entries, filter, query, viewerUserId],
  );
  const rows = useMemo(
    () => visible.map((entry) => toFeedbackRowView({
      entry,
      viewerUserId,
      memberNames,
      now,
    })),
    [memberNames, now, viewerUserId, visible],
  );
  // Resolved against the whole index rather than the filtered rows, unlike the
  // Inbox: answering the request you are reading moves it out of "Needs my
  // response", and the pane must not blank out underneath the person who just
  // submitted. The row simply stops being listed.
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.requestId === selectedId) ?? null,
    [entries, selectedId],
  );

  const clearFilters = useCallback(() => {
    setFilter('all');
    setQuery('');
  }, []);

  return (
    <section
      className="feedback-surface flex h-full min-h-0 flex-col [container-name:feedback-surface] [container-type:inline-size]"
      data-testid="feedback-surface"
      data-component="FeedbackSection"
      data-source="packages/electron/src/renderer/components/CollabMode/Feedback/FeedbackSection.tsx"
    >
      <header className="feedback-header shrink-0 border-b border-[var(--nim-border)] px-5 py-4">
        <div className="feedback-header-title flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--nim-purple)_16%,transparent)] text-[var(--nim-purple)]">
            <MaterialSymbol icon="ballot" size={14} />
          </span>
          <h2 className="m-0 text-[15px] font-semibold text-[var(--nim-text)]">Feedback</h2>
          {counts.all > 0 && (
            <span
              className="feedback-header-count rounded-full bg-[color-mix(in_srgb,var(--nim-purple)_20%,transparent)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--nim-purple)]"
              data-testid="feedback-header-count"
            >
              {counts.all}
            </span>
          )}
          <label className="feedback-search ml-auto flex w-[220px] items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2.5 py-1">
            <MaterialSymbol icon="search" size={14} className="shrink-0 text-[var(--nim-text-faint)]" />
            <input
              type="search"
              className="min-w-0 flex-1 border-none bg-transparent text-[12px] text-[var(--nim-text)] outline-none placeholder:text-[var(--nim-text-faint)]"
              placeholder="Search requests…"
              data-testid="feedback-search-input"
              aria-label="Search feedback requests"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        <div
          className="feedback-filter-bar mt-3 flex flex-wrap items-center gap-1.5"
          role="tablist"
          aria-label="Feedback filters"
          data-testid="feedback-filter-bar"
        >
          {FEEDBACK_LIST_FILTERS.map((entry) => (
            <React.Fragment key={entry.id}>
              {entry.startsGroup && (
                <span
                  className="feedback-filter-divider mx-1 h-5 w-px shrink-0 bg-[var(--nim-border)]"
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={filter === entry.id}
                className={`feedback-filter-chip flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] ${
                  filter === entry.id
                    ? 'bg-[var(--nim-primary)] font-medium text-[var(--nim-on-primary)]'
                    : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
                }`}
                data-testid={`feedback-filter-${entry.id}`}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
                {counts[entry.id] > 0 && (
                  <span
                    className={`feedback-filter-count rounded-full px-1.5 text-[10px] font-semibold leading-4 ${
                      filter === entry.id
                        ? 'bg-[color-mix(in_srgb,var(--nim-on-primary)_25%,transparent)] text-[var(--nim-on-primary)]'
                        : 'bg-[var(--nim-bg-active)] text-[var(--nim-text-muted)]'
                    }`}
                    data-testid={`feedback-filter-count-${entry.id}`}
                  >
                    {counts[entry.id]}
                  </span>
                )}
              </button>
            </React.Fragment>
          ))}
        </div>
      </header>

      <div className="feedback-body flex min-h-0 flex-1">
        <div
          className={`feedback-list-pane min-w-0 flex-1 overflow-y-auto ${
            selectedEntry ? 'hidden @[880px]/feedback-surface:block' : 'block'
          }`}
          data-testid="feedback-list-pane"
        >
          {!workspacePath
            ? (
              <FeedbackNotice
                testId="feedback-no-workspace"
                icon="cloud_off"
                message="Connecting to this project's shared area. Feedback requests appear once it resolves."
              />
            )
            : !viewerUserId
              ? (
                // No verified team-room identity has ever written this index,
                // which is a signed-out client and a not-yet-synced one alike.
                // The copy covers both rather than telling a signed-in member
                // they are signed out.
                <FeedbackNotice
                  testId="feedback-no-identity"
                  icon="sync_problem"
                  message="No feedback requests have reached this device yet. They appear once your team connection is signed in and synced."
                />
              )
              : rows.length === 0
                ? (
                  <FeedbackNotice
                    testId="feedback-empty"
                    icon="ballot"
                    message={counts.all === 0
                      ? 'No feedback requests yet. When someone asks you for feedback — or you ask your team — the request lands here and stays after it is answered.'
                      : 'No requests match this filter.'}
                    action={counts.all === 0
                      ? undefined
                      : { label: 'Clear filters', onClick: clearFilters }}
                  />
                )
                : (
                  <div className="feedback-list" data-testid="feedback-list" role="list">
                    {rows.map((row) => (
                      <FeedbackRow
                        key={row.id}
                        row={row}
                        selected={row.id === selectedId}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                )}
        </div>

        <aside
          className={`feedback-detail-pane min-h-0 flex-col border-l border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] ${
            selectedEntry
              ? 'flex w-full @[880px]/feedback-surface:w-[440px] @[880px]/feedback-surface:shrink-0'
              : 'hidden @[880px]/feedback-surface:flex @[880px]/feedback-surface:w-[440px] @[880px]/feedback-surface:shrink-0'
          }`}
          data-testid="feedback-detail-pane"
        >
          {selectedEntry && workspacePath
            ? (
              <>
                <button
                  type="button"
                  className="feedback-detail-back flex items-center gap-1.5 border-b border-[var(--nim-border)] px-3 py-2 text-left text-[12px] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] @[880px]/feedback-surface:hidden"
                  data-testid="feedback-detail-back"
                  onClick={() => setSelectedId(null)}
                >
                  <MaterialSymbol icon="arrow_back" size={14} />
                  All requests
                </button>
                <div className="feedback-detail-body min-h-0 flex-1 select-text overflow-y-auto p-3">
                  <FeedbackRequestSurface
                    // Remounting on selection keeps the respond draft bound to
                    // the request it was typed against.
                    key={selectedEntry.requestId}
                    workspacePath={workspacePath}
                    orgId={orgId}
                    requestId={selectedEntry.requestId}
                    teamMemberId={viewerUserId || undefined}
                    title={selectedEntry.title}
                  />
                </div>
              </>
            )
            : (
              <div
                className="feedback-detail-empty flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
                data-testid="feedback-detail-empty"
              >
                <MaterialSymbol icon="ballot" size={22} className="text-[var(--nim-text-faint)]" />
                <p className="m-0 max-w-[260px] text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                  Select a request to answer it, or to read the answers it already has.
                </p>
              </div>
            )}
        </aside>
      </div>
    </section>
  );
}

function FeedbackNotice({
  testId,
  icon,
  message,
  action,
}: {
  testId: string;
  icon: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      className="feedback-notice flex flex-col items-center justify-center gap-2 px-8 py-12 text-center"
      data-testid={testId}
    >
      <MaterialSymbol icon={icon} size={22} className="text-[var(--nim-text-faint)]" />
      <p className="m-0 max-w-[380px] text-[12.5px] leading-relaxed text-[var(--nim-text-muted)]">
        {message}
      </p>
      {action && (
        <button
          type="button"
          className="feedback-notice-action rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          data-testid="feedback-notice-action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
