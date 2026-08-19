/**
 * FeedbackRequestResults
 *
 * The author's view of a feedback request, opened as its own tab because a
 * request is a resource rather than a message. Same card as the compose and
 * respond surfaces, so a request looks the same wherever you meet it.
 *
 * Nothing blocks on a recipient, so this surface carries everything the
 * blocking call would have carried: the tallies, who is outstanding, the chase,
 * and when the session wakes.
 *
 * Two things are load-bearing and neither is visible on screen:
 *
 * - **Attribution follows the request's visibility and nothing else.** There is
 *   no attribution control here and there must never be one -- decision 10 says
 *   `visibility` already carries it. `buildFeedbackResults` reads that gate once
 *   and hands back voters or nothing; this component renders whatever it is
 *   given and never inspects a recipient id itself. Reveal-after-complete is
 *   deliberately *not* implemented: a hidden request stays anonymous forever,
 *   including to the author, including once everyone has answered. See the
 *   header comment in `feedbackResultsModel.ts`.
 * - **Everything is counted once.** The whole results model is one memo over the
 *   request snapshot. No row recomputes a tally, and the outstanding list is not
 *   a lookup per recipient.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  FloatingPortal,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type {
  FeedbackAskArtifact,
  FeedbackRequestLifecycleStatus,
} from '@nimbalyst/collab-protocol';
import {
  FeedbackArtifactSubjects,
  type FeedbackArtifactActionResolver,
} from '@nimbalyst/collab-client/feedback-ui';
import {
  InteractiveWidgetBody,
  InteractiveWidgetCard,
  InteractiveWidgetHeader,
  WidgetActionButton,
  WidgetBlock,
  WidgetNoteRow,
  WidgetStatusPill,
} from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/shared/InteractiveWidgetChrome';
import { FeedbackCopyLinkButton } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/feedback/FeedbackCopyLinkButton';

import type { FeedbackRequestServiceTarget } from '../../../shared/feedbackRequest';
import { feedbackRequestConsoleUrl } from '../../../shared/feedbackRequestLinks';
import {
  feedbackRequestProgressAtomFamily,
  feedbackRequestStateForTargetAtomFamily,
  feedbackRequestTargetKey,
} from '../../store/atoms/feedbackRequests';
import {
  buildFeedbackResults,
  type FeedbackAskResult,
  type FeedbackChoiceResult,
  type FeedbackRankedResult,
  type FeedbackRatingResult,
  type FeedbackResultsVoter,
  type FeedbackTextResult,
} from './feedbackResultsModel';

export interface FeedbackResultsActionResult {
  success: boolean;
  error?: string;
}

/**
 * Optional, as on every other feedback surface: with no host the results still
 * render honestly and the surface says plainly that it cannot act.
 */
export interface FeedbackResultsHost {
  /** Omitted recipients nudges everyone outstanding, server-side. */
  nudge(recipientUserIds?: string[]): Promise<FeedbackResultsActionResult>;
  close(
    status: Exclude<FeedbackRequestLifecycleStatus, 'open' | 'expired'>,
  ): Promise<FeedbackResultsActionResult>;
}

export interface FeedbackRequestResultsProps {
  target: FeedbackRequestServiceTarget;
  host?: FeedbackResultsHost;
  /** Opens a bound artifact from the tally; absent leaves the labels inert. */
  onOpenArtifact?: (artifact: FeedbackAskArtifact) => void;
  /** Resolves subjects and bound artifacts before rendering an open control. */
  resolveArtifactAction?: FeedbackArtifactActionResolver;
  /** Overridden in tests; deadline copy is the only thing that reads it. */
  now?: number;
}

const LIFECYCLE_PILL: Record<
  FeedbackRequestLifecycleStatus,
  { tone: 'primary' | 'success' | 'muted' | 'warning'; label: string }
> = {
  open: { tone: 'primary', label: 'Open' },
  closed: { tone: 'success', label: 'Closed' },
  expired: { tone: 'warning', label: 'Expired' },
  cancelled: { tone: 'muted', label: 'Cancelled' },
};

const FeedbackIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="w-full h-full">
    <path
      d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v6A1.5 1.5 0 0 1 12.5 12H6l-3 2.2V12h-.5A1.5 1.5 0 0 1 1 10.5v-6"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <circle cx="6" cy="7.5" r="0.9" fill="currentColor" />
    <circle cx="9" cy="7.5" r="0.9" fill="currentColor" />
  </svg>
);

const ClockIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 15 15" fill="none" className="w-full h-full">
    <circle cx="7.5" cy="7.5" r="5.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M7.5 4.4v3.4l2.2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const LeaderIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
    <path
      d="M2.5 6.8 5.2 9.5l5.3-6"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Small presentation pieces
// ---------------------------------------------------------------------------

const VoterStack: React.FC<{ voters: FeedbackResultsVoter[] }> = ({ voters }) => {
  if (voters.length === 0) return null;
  return (
    <span className="feedback-results-voters flex" data-testid="feedback-results-voters">
      {voters.map((voter) => (
        <span
          key={voter.userId}
          title={voter.name}
          className="-ml-1.5 flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-[var(--nim-bg-secondary)] bg-nim-tertiary text-[0.5625rem] font-bold text-nim-muted first:ml-0"
        >
          {voter.initials}
        </span>
      ))}
    </span>
  );
};

/**
 * "B won" is only actionable if B is still reachable, so a bound artifact gets
 * an opener right where the result is read. Silent when the host cannot open
 * one, rather than a button that does nothing.
 */
const ArtifactLink: React.FC<{
  artifact: FeedbackAskArtifact;
  onOpen?: (artifact: FeedbackAskArtifact) => void;
  resolveAction?: FeedbackArtifactActionResolver;
}> = ({ artifact, onOpen, resolveAction }) => {
  const action = resolveAction?.(artifact)
    ?? (onOpen ? { open: () => onOpen(artifact) } : {});
  if (!action.open) {
    return action.unavailableReason ? (
      <span className="feedback-results-artifact-unavailable mt-0.5 block text-[0.6875rem] font-normal text-nim-faint">
        {action.unavailableReason}
      </span>
    ) : null;
  }
  return (
    <button
      type="button"
      data-testid="feedback-results-open-artifact"
      aria-label={`Open ${artifact.label}`}
      onClick={action.open}
      className="feedback-results-artifact-link mt-0.5 block max-w-full truncate text-left text-[0.6875rem] font-normal text-nim-muted underline decoration-dotted cursor-pointer hover:text-nim"
    >
      {artifact.label}
    </button>
  );
};

const ChoiceTally: React.FC<{
  detail: FeedbackChoiceResult;
  onOpenArtifact?: (artifact: FeedbackAskArtifact) => void;
  resolveArtifactAction?: FeedbackArtifactActionResolver;
}> = ({ detail, onOpenArtifact, resolveArtifactAction }) => (
  <div className="feedback-results-tally flex flex-col gap-2">
    {detail.options.map((option) => (
      <div
        key={option.optionId}
        data-testid="feedback-results-tally-row"
        className="feedback-results-tally-row flex items-center gap-3 @[max-420px]/feedback-results:gap-2"
      >
        <div className="w-[7.5rem] shrink-0 select-text text-xs font-medium text-nim @[max-420px]/feedback-results:w-20">
          {option.label}
          {option.description && (
            <span className="mt-0.5 block text-[0.6875rem] font-normal text-nim-faint @[max-420px]/feedback-results:hidden">
              {option.description}
            </span>
          )}
          {option.artifact && (
            <ArtifactLink
              artifact={option.artifact}
              onOpen={onOpenArtifact}
              resolveAction={resolveArtifactAction}
            />
          )}
        </div>
        <div className="h-6 flex-1 overflow-hidden rounded border border-nim bg-nim-secondary">
          <div
            className={
              option.isLeader
                ? 'h-full rounded-l-[3px] bg-nim-primary'
                : 'h-full rounded-l-[3px] bg-[color-mix(in_srgb,var(--nim-primary)_35%,transparent)]'
            }
            style={{ width: `${Math.max(option.percent, option.count > 0 ? 4 : 1)}%` }}
          />
        </div>
        <div className="flex w-24 shrink-0 items-center justify-end gap-2">
          {option.isLeader && (
            <span className="flex text-nim-success" aria-label="Leading">
              <LeaderIcon />
            </span>
          )}
          <span className="font-mono text-xs font-semibold text-nim-muted">{option.count}</span>
          <VoterStack voters={option.voters} />
        </div>
      </div>
    ))}
    {detail.otherNotes.length > 0 && (
      <div className="feedback-results-other-notes mt-1 flex flex-col gap-1 border-t border-nim pt-2">
        {detail.otherNotes.map((note) => (
          <div key={note.id} className="select-text text-xs text-nim-muted">
            {note.author ? `${note.author.name}: ` : ''}
            {note.text}
          </div>
        ))}
      </div>
    )}
  </div>
);

const RankedConsolidation: React.FC<{
  detail: FeedbackRankedResult;
  onOpenArtifact?: (artifact: FeedbackAskArtifact) => void;
  resolveArtifactAction?: FeedbackArtifactActionResolver;
}> = ({ detail, onOpenArtifact, resolveArtifactAction }) => {
  const tallest = Math.max(
    1,
    ...detail.entries.flatMap((entry) => entry.positionCounts),
  );
  return (
    <div className="feedback-results-ranked flex flex-col gap-2">
      {detail.entries.map((entry) => (
        <div
          key={entry.itemId}
          data-testid="feedback-results-ranked-row"
          data-contested={entry.contested ? 'true' : 'false'}
          className="feedback-results-ranked-row flex items-center gap-3 rounded-md border border-nim bg-nim-secondary px-3 py-2.5"
        >
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded bg-[color-mix(in_srgb,var(--nim-primary)_14%,transparent)] font-mono text-[0.6875rem] font-bold text-nim-primary">
            {entry.rank}
          </span>
          <div className="min-w-0 flex-1">
            <div className="select-text text-[0.8125rem] font-medium text-nim">{entry.title}</div>
            {entry.artifact && (
              <ArtifactLink
                artifact={entry.artifact}
                onOpen={onOpenArtifact}
                resolveAction={resolveArtifactAction}
              />
            )}
            <div
              className={
                entry.contested
                  ? 'mt-0.5 text-[0.6875rem] text-nim-warning'
                  : 'mt-0.5 text-[0.6875rem] text-nim-faint'
              }
            >
              {entry.summary}
            </div>
          </div>
          <div className="w-24 shrink-0">
            <div className="flex h-5 items-end gap-[3px]">
              {entry.positionCounts.map((count, position) => (
                <i
                  key={position}
                  title={`${count} put it ${position + 1} of ${detail.positionCount}`}
                  className={
                    count > 0
                      ? 'block min-h-[2px] flex-1 rounded-t-sm bg-nim-primary'
                      : 'block min-h-[2px] flex-1 rounded-t-sm bg-nim-tertiary'
                  }
                  style={{ height: `${Math.round((count / tallest) * 100)}%` }}
                />
              ))}
            </div>
            <div className="mt-[3px] flex gap-[3px] font-mono text-[0.5625rem] text-nim-faint">
              {entry.positionCounts.map((_, position) => (
                <span key={position} className="flex-1 text-center">
                  {position + 1}
                </span>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const TextAnswers: React.FC<{ detail: FeedbackTextResult }> = ({ detail }) => {
  if (detail.answers.length === 0) {
    return <div className="text-xs text-nim-faint">No written answers yet.</div>;
  }
  return (
    <div className="feedback-results-text-answers flex flex-col">
      {detail.answers.map((answer) => (
        <div
          key={answer.id}
          data-testid="feedback-results-text-answer"
          className="flex items-start gap-2.5 border-b border-nim py-2.5 last:border-b-0 last:pb-0"
        >
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-nim-tertiary text-[0.5625rem] font-bold text-nim-muted">
            {answer.author ? answer.author.initials : '·'}
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-nim">
              {answer.author ? answer.author.name : 'Anonymous'}
              <span className="ml-1.5 font-normal text-nim-faint">
                {formatWhen(answer.answeredAt)}
              </span>
            </div>
            <div className="mt-0.5 select-text text-xs leading-relaxed text-nim-muted">
              {answer.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const RatingSummary: React.FC<{ detail: FeedbackRatingResult }> = ({ detail }) => (
  <div className="feedback-results-rating select-text text-xs text-nim-muted">
    {detail.count === 0
      ? 'No ratings yet.'
      : `Average ${detail.mean.toFixed(1)} of ${detail.scaleMax}`
        + ` · lowest ${detail.lowest}, highest ${detail.highest}`
        + ` · ${detail.count} ${detail.count === 1 ? 'rating' : 'ratings'}`}
  </div>
);

const AskResultBlock: React.FC<{
  result: FeedbackAskResult;
  onOpenArtifact?: (artifact: FeedbackAskArtifact) => void;
  resolveArtifactAction?: FeedbackArtifactActionResolver;
}> = ({ result, onOpenArtifact, resolveArtifactAction }) => {
  const { detail } = result;
  const hint = detail.kind === 'ranked'
    ? `ranked · consolidated from ${detail.orderingCount} ${detail.orderingCount === 1 ? 'ordering' : 'orderings'}`
    : `${result.answeredCount} of ${result.assignedCount} assigned answered`;

  return (
    <WidgetBlock
      testId="feedback-results-ask"
      rootClassName="feedback-results-ask"
      tag={`Q${result.index} · ${result.ask.label}`}
      hint={hint}
      question={result.ask.description || result.ask.label}
      selectableQuestion
    >
      {detail.kind === 'choice' && (
        <ChoiceTally
          detail={detail}
          onOpenArtifact={onOpenArtifact}
          resolveArtifactAction={resolveArtifactAction}
        />
      )}
      {detail.kind === 'ranked' && (
        <RankedConsolidation
          detail={detail}
          onOpenArtifact={onOpenArtifact}
          resolveArtifactAction={resolveArtifactAction}
        />
      )}
      {detail.kind === 'text' && <TextAnswers detail={detail} />}
      {detail.kind === 'rating' && <RatingSummary detail={detail} />}
    </WidgetBlock>
  );
};

// ---------------------------------------------------------------------------
// Lifecycle menu
// ---------------------------------------------------------------------------

const LifecycleMenu: React.FC<{
  disabled: boolean;
  onCancel: () => void;
}> = ({ disabled, onCancel }) => {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        {...getReferenceProps({ onClick: () => setOpen((current) => !current) })}
        disabled={disabled}
        data-testid="feedback-results-lifecycle-menu"
        aria-label="More request actions"
        className="feedback-results-lifecycle-menu rounded-md border border-nim bg-nim-tertiary px-2 py-1.5 text-[13px] leading-none text-nim-muted transition-colors duration-150 hover:bg-nim-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        &#8943;
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="feedback-results-lifecycle-popover z-50 min-w-[13rem] rounded-md border border-nim bg-nim-secondary py-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              data-testid="feedback-results-cancel"
              onClick={() => {
                setOpen(false);
                onCancel();
              }}
              className="block w-full cursor-pointer border-none bg-transparent px-3 py-1.5 text-left text-xs text-nim-muted hover:bg-nim-hover hover:text-nim"
            >
              Cancel request
            </button>
            <div className="px-3 pb-1 pt-0.5 text-[0.6875rem] leading-snug text-nim-faint">
              Cancelling drops the answers already in. Closing keeps them.
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export const FeedbackRequestResults: React.FC<FeedbackRequestResultsProps> = ({
  target,
  host,
  onOpenArtifact,
  resolveArtifactAction,
  now,
}) => {
  const atomKey = useMemo(() => feedbackRequestTargetKey(target), [target]);
  // The state atom rather than the request/responses selectors that derive from
  // it: this surface needs the viewer id and the connection status too, and one
  // subscription to the source cannot drift from another. `request.responses`
  // *is* what `feedbackRequestResponsesForViewerAtomFamily` returns -- the set
  // the server projected for this viewer, rendered as handed over.
  const state = useAtomValue(feedbackRequestStateForTargetAtomFamily(atomKey));
  const progress = useAtomValue(feedbackRequestProgressAtomFamily(atomKey));
  const request = state.request;

  // The pasteable link for this request. Available before the snapshot loads
  // and after the request closes: it is addressed from the target alone, and
  // chasing somebody is exactly when an author comes back to this tab.
  const shareUrl = useMemo(
    () => feedbackRequestConsoleUrl(target.orgId, target.requestId),
    [target.orgId, target.requestId],
  );

  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nudgedAt, setNudgedAt] = useState<number | null>(null);
  const [clock] = useState(() => now ?? Date.now());

  // The whole model, once per snapshot. Every row below reads from this.
  const results = useMemo(
    () => (request ? buildFeedbackResults(request, progress) : null),
    [request, progress],
  );

  const runAction = useCallback(async (
    key: string,
    action: () => Promise<FeedbackResultsActionResult>,
  ) => {
    setPendingAction(key);
    setActionError(null);
    try {
      const result = await action();
      if (!result.success) {
        setActionError(result.error ?? 'That did not go through.');
        return false;
      }
      return true;
    } catch (error) {
      console.error('[FeedbackRequestResults] Action failed:', error);
      setActionError(error instanceof Error ? error.message : 'That did not go through.');
      return false;
    } finally {
      setPendingAction(null);
    }
  }, []);

  const handleNudge = useCallback(async (recipientUserIds?: string[]) => {
    if (!host) return;
    const key = recipientUserIds?.length ? `nudge:${recipientUserIds[0]}` : 'nudge:all';
    const sent = await runAction(key, () => host.nudge(recipientUserIds));
    if (sent) setNudgedAt(Date.now());
  }, [host, runAction]);

  const handleLifecycle = useCallback(async (status: 'closed' | 'cancelled') => {
    if (!host) return;
    await runAction(status, () => host.close(status));
  }, [host, runAction]);

  if (!request || !results) {
    return (
      <InteractiveWidgetCard
        rootClassName="feedback-request-results"
        testId="feedback-request-results"
        state={state.status === 'error' ? 'error' : 'loading'}
        tone="resolved"
      >
        <InteractiveWidgetHeader
          icon={<FeedbackIcon />}
          title="Feedback request"
          // The tab opens the moment the request is sent, which is precisely
          // when the author wants the link — before the snapshot arrives.
          trailing={(
            <FeedbackCopyLinkButton
              url={shareUrl}
              testId="feedback-results-copy-link"
              rootClassName="feedback-results-copy-link"
            />
          )}
        />
        <InteractiveWidgetBody>
          <div className="select-text text-xs text-nim-muted">
            {state.error?.message ?? 'Loading this request…'}
          </div>
        </InteractiveWidgetBody>
      </InteractiveWidgetCard>
    );
  }

  const isAuthor = request.author.onBehalfOfUserId === state.teamMemberId;
  const isOpen = request.lifecycle.status === 'open';
  const canAct = isAuthor && isOpen && Boolean(host) && pendingAction === null;
  const lifecyclePill = LIFECYCLE_PILL[request.lifecycle.status];
  const outstanding = results.outstanding;
  const quorumReached = progress?.quorumReached ?? false;

  const wakeCopy = !isOpen
    ? `This request is ${lifecyclePill.label.toLowerCase()}. The session has been woken with what came in.`
    : quorumReached
      ? 'Quorum is in, so the session has been woken with these answers.'
      : `The session wakes when ${request.quorum.requiredRecipientCount} of `
        + `${results.totalRecipientCount} have answered, when you close this request, `
        + 'or when you nudge someone. Nothing has been sent to it yet.';

  return (
    <InteractiveWidgetCard
      rootClassName="feedback-request-results @container/feedback-results"
      testId="feedback-request-results"
      state={request.lifecycle.status}
      tone={isOpen ? 'active' : 'resolved'}
    >
      <InteractiveWidgetHeader
        icon={<FeedbackIcon />}
        title={
          <span className="flex flex-col">
            <span className="select-text">Feedback request</span>
            <span className="text-[0.6875rem] font-normal text-nim-faint">
              Sent {formatWhen(request.createdAt)}
              {request.deadline !== undefined && ` · Due ${formatWhen(request.deadline)}`}
            </span>
          </span>
        }
        trailing={
          <span className="flex flex-wrap items-center justify-end gap-2">
            <WidgetStatusPill tone="primary" testId="feedback-results-progress">
              {`${results.answeredRecipientCount} of ${results.totalRecipientCount} responded`}
            </WidgetStatusPill>
            <WidgetStatusPill tone={lifecyclePill.tone}>{lifecyclePill.label}</WidgetStatusPill>
            {/* Not behind the lifecycle menu, and not gated on authorship: a
                recipient without the desktop app is reached by this link or by
                nothing at all. */}
            <FeedbackCopyLinkButton
              url={shareUrl}
              testId="feedback-results-copy-link"
              rootClassName="feedback-results-copy-link"
            />
            {isAuthor && isOpen && (
              <>
                <WidgetActionButton
                  variant="primary"
                  testId="feedback-results-close"
                  onClick={() => void handleLifecycle('closed')}
                  disabled={!canAct}
                >
                  {pendingAction === 'closed' ? 'Closing…' : 'Close request'}
                </WidgetActionButton>
                <LifecycleMenu
                  disabled={!canAct}
                  onCancel={() => void handleLifecycle('cancelled')}
                />
              </>
            )}
          </span>
        }
      />

      <InteractiveWidgetBody>
        {/* Above the tallies, in the same slot the respond surface puts it: an
            author reading "B won" a week later needs B in reach, and the two
            views of one request should not be laid out differently. Renders
            nothing at all when the request has no subjects. */}
        <FeedbackArtifactSubjects
          subjects={request.subjects}
          resolveAction={resolveArtifactAction}
        />

        {results.askResults.map((result) => (
          <AskResultBlock
            key={result.ask.id}
            result={result}
            onOpenArtifact={onOpenArtifact}
            resolveArtifactAction={resolveArtifactAction}
          />
        ))}

        <WidgetBlock
          testId="feedback-results-outstanding"
          rootClassName="feedback-results-outstanding"
          tag="Waiting on"
          tagTone="neutral"
          hint={
            outstanding.kind === 'named'
              ? `${outstanding.count} ${outstanding.count === 1 ? 'person' : 'people'}`
              : outstanding.count === null
                ? 'answers stay anonymous on this request'
                : `${outstanding.count} ${outstanding.count === 1 ? 'person' : 'people'} · names stay hidden`
          }
        >
          {outstanding.kind === 'named' ? (
            outstanding.people.length === 0 ? (
              <div className="text-xs text-nim-faint">Everyone has answered.</div>
            ) : (
              <div className="flex flex-col">
                {outstanding.people.map((person) => (
                  <div
                    key={person.userId}
                    data-testid="feedback-results-outstanding-person"
                    className="flex items-center gap-2.5 border-b border-nim py-2 last:border-b-0 last:pb-0"
                  >
                    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-nim-tertiary text-[0.5625rem] font-bold text-nim-muted">
                      {person.initials}
                    </span>
                    <div className="min-w-0">
                      <div className="select-text text-xs font-medium text-nim">{person.name}</div>
                      <div className="text-[0.6875rem] text-nim-faint">
                        {person.pendingAskLabels.join(', ')}
                      </div>
                    </div>
                    <span className="ml-auto">
                      <WidgetActionButton
                        variant="secondary"
                        testId="feedback-results-nudge-person"
                        onClick={() => void handleNudge([person.userId])}
                        disabled={!canAct}
                      >
                        {pendingAction === `nudge:${person.userId}` ? 'Nudging…' : 'Nudge'}
                      </WidgetActionButton>
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="select-text text-xs text-nim-muted">
              {outstanding.count === 0
                ? 'Everyone has answered.'
                : 'Answers on this request are anonymous, so who is still outstanding stays'
                  + ' hidden here too — naming them would identify the answers already in.'
                  + ' Nudging goes to everyone who has not answered.'}
            </div>
          )}
          {(outstanding.kind === 'anonymous' || outstanding.people.length > 0) && (
            <div className="mt-3 flex items-center gap-2 border-t border-nim pt-2.5">
              <WidgetActionButton
                variant="secondary"
                testId="feedback-results-nudge-all"
                onClick={() => void handleNudge()}
                disabled={!canAct}
              >
                {pendingAction === 'nudge:all' ? 'Nudging…' : 'Nudge everyone outstanding'}
              </WidgetActionButton>
              {nudgedAt !== null && (
                <span className="text-[0.6875rem] text-nim-faint">
                  Nudged {formatWhen(nudgedAt)}
                </span>
              )}
            </div>
          )}
        </WidgetBlock>

        <WidgetNoteRow
          icon={<ClockIcon />}
          rootClassName="feedback-results-wake-note"
          testId="feedback-results-wake-note"
        >
          {wakeCopy}
        </WidgetNoteRow>

        {!results.attributed && (
          <WidgetNoteRow
            rootClassName="feedback-results-anonymous-note"
            testId="feedback-results-anonymous-note"
          >
            You asked for this one hidden until answered, so the tally is anonymous —
            for you as well, and it stays that way after everyone has answered.
          </WidgetNoteRow>
        )}

        {!isAuthor && (
          <WidgetNoteRow
            rootClassName="feedback-results-observer-note"
            testId="feedback-results-observer-note"
          >
            You are not the author of this request, so closing and nudging are not yours
            to do here.
          </WidgetNoteRow>
        )}

        {!host && isAuthor && (
          <WidgetNoteRow rootClassName="feedback-results-offline-note">
            Closing and nudging are not available in this session yet.
          </WidgetNoteRow>
        )}

        {actionError && (
          <WidgetNoteRow
            rootClassName="feedback-results-action-error"
            testId="feedback-results-action-error"
          >
            {actionError}
          </WidgetNoteRow>
        )}
      </InteractiveWidgetBody>
    </InteractiveWidgetCard>
  );
};
