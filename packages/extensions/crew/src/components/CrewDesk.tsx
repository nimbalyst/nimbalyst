/**
 * A member's desk: header, chapter timeline with the chapter's transcript in
 * the center, and the Inbox/Schedule/Delegated/Notes panel on the right.
 */
import { useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/extension-sdk';
import type { CrewChapterSummary, CrewMemberDetail, CrewMemberSnapshot } from '../shared/types';
import { CrewAvatar, CrewError, CrewModal, CrewToggle } from './CrewBits';
import { useCrew, useCrewAction, useCrewQuery } from './CrewContext';
import { CrewDeskPanel } from './CrewDeskPanel';
import { CrewPaneResizer, useCrewPanes } from './CrewPanes';
import { deriveShiftAction, describeTrigger, splitChapters, STATUS_LABEL } from './crewDeskModel';
import { formatDateRange, formatDay, formatTokens, formatWhen } from './crewFormat';

export function CrewDesk({ member }: { member: CrewMemberSnapshot }) {
  const { client } = useCrew();
  const slug = member.definition.slug;
  const detail = useCrewQuery(() => client.call('member', { slug }), [slug]);
  const { deskPanelCollapsed } = useCrewPanes();

  return (
    <div className="crew-desk" data-member-slug={slug} data-testid="crew-desk">
      <CrewDeskHeader member={member} />
      <div className="crew-desk-body">
        <CrewChapterTimeline member={member} detail={detail.data ?? null} loadError={detail.error} />
        {!deskPanelCollapsed && (
          <>
            <CrewPaneResizer side="right" />
            <CrewDeskPanel member={member} detail={detail.data ?? null} />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

function CrewDeskHeader({ member }: { member: CrewMemberSnapshot }) {
  const { client, host, select } = useCrew();
  const { busy, error, run } = useCrewAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { definition, runtime } = member;
  const usage = runtime.usage;
  const slug = definition.slug;
  const paused = definition.paused === true || runtime.status === 'paused';
  const shift = deriveShiftAction(member);
  const limit = usage.tokensPerWeekLimit;
  const usedPct = limit > 0 ? Math.min(100, (usage.tokensThisWeek / limit) * 100) : 0;

  return (
    <header className="crew-desk-header">
      <div className="crew-desk-header-row">
        <CrewAvatar definition={definition} size={40} status={runtime.status} />
        <div className="crew-desk-identity">
          <div className="crew-desk-name">
            {definition.name}
            <span className="crew-faint crew-desk-role">{definition.role}</span>
            <span className="crew-status-pill" data-status={runtime.status}>{STATUS_LABEL[runtime.status]}</span>
          </div>
          <div className="crew-desk-meta">
            <span><span className="crew-faint">Model</span> {definition.provider}:{definition.model}</span>
            <span>
              <span className="crew-faint">Next run</span>{' '}
              {paused ? 'paused' : runtime.nextRunAt ? formatWhen(runtime.nextRunAt) : 'none scheduled'}
            </span>
            <span className="crew-desk-budget" data-over={usage.overBudget}>
              <span className="crew-faint">Budget</span>
              {formatTokens(usage.tokensThisWeek)} / {limit > 0 ? formatTokens(limit) : 'no cap'} this week
              {limit > 0 && (
                <span className="crew-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedPct)} aria-label="Weekly token budget used">
                  <span className="crew-meter-fill" data-warn={usage.overBudget || usedPct >= 90} style={{ width: `${usedPct}%` }} />
                </span>
              )}
            </span>
            <span><span className="crew-faint">Shifts today</span> {usage.shiftsToday} of {usage.shiftsPerDayLimit}</span>
          </div>
        </div>
        <div className="crew-desk-actions">
          <span className="crew-inline-label">
            <CrewToggle
              label="Pause"
              checked={paused}
              disabled={busy !== null}
              onChange={(next) => void run('pause', () => client.call('setPaused', { slug, paused: next }))}
            />
            Pause
          </span>
          {shift.kind === 'end' ? (
            <button type="button" className="crew-btn crew-btn-secondary" disabled={busy !== null} onClick={() => void run('shift', () => client.call('endShift', { slug }))}>
              <MaterialSymbol icon="stop" size={15} />
              End shift
            </button>
          ) : (
            <button
              type="button"
              className="crew-btn crew-btn-primary"
              disabled={busy !== null || shift.blockedReason !== undefined}
              title={shift.blockedReason}
              onClick={() => void run('shift', () => client.call('startShift', { slug }))}
            >
              <MaterialSymbol icon="play_arrow" size={15} />
              Start shift
            </button>
          )}
          <button type="button" className="crew-icon-button" title="Remove from the crew" aria-label="Remove from the crew" onClick={() => setConfirmRemove(true)}>
            <MaterialSymbol icon="person_remove" size={17} />
          </button>
        </div>
      </div>

      <div className="crew-desk-definition">
        <MaterialSymbol icon="description" size={14} />
        <span className="crew-grow">
          {runtime.definitionChangedSinceChapter
            ? <><b>The definition changed during this chapter.</b> The new personality, job and model take effect when the next chapter starts.</>
            : 'Edits to the definition take effect when the next chapter starts.'}
        </span>
        <button type="button" className="crew-link-button" onClick={() => host.openFile(definition.sourcePath)}>
          Edit definition
        </button>
      </div>

      {runtime.errors.length > 0 && (
        <ul className="crew-definition-errors crew-selectable" role="alert">
          {runtime.errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <CrewError message={error} />

      {confirmRemove && (
        <CrewModal
          title={`Remove ${definition.name}?`}
          onClose={() => setConfirmRemove(false)}
          footer={(
            <>
              <button type="button" className="crew-btn crew-btn-secondary" onClick={() => setConfirmRemove(false)}>Cancel</button>
              <button
                type="button"
                className="crew-btn crew-btn-danger"
                disabled={busy !== null}
                onClick={async () => {
                  const removed = await run('remove', () => client.call('deleteMember', { slug }));
                  if (removed) {
                    setConfirmRemove(false);
                    select(null);
                  }
                }}
              >
                Remove
              </button>
            </>
          )}
        >
          <p className="crew-modal-text">
            {definition.name}'s definition, notes and journal move to <span className="crew-mono">nimbalyst-local/crew/.deleted/</span>. Their sessions stay where they are.
          </p>
        </CrewModal>
      )}
    </header>
  );
}

// ─── Chapter timeline ──────────────────────────────────────────────────────

/** How many earlier chapters show before the rest fold behind a toggle. */
const VISIBLE_EARLIER_CHAPTERS = 1;

/**
 * The desk's center column. Earlier chapters are collapsed cards carrying
 * their handoff summary; only the session being read mounts a transcript.
 */
function CrewChapterTimeline({
  member,
  detail,
  loadError,
}: {
  member: CrewMemberSnapshot;
  detail: CrewMemberDetail | null;
  loadError: string | null;
}) {
  const { host, viewingSessionId, viewSession } = useCrew();
  const [showAll, setShowAll] = useState(false);
  const { definition, runtime } = member;
  const slug = definition.slug;
  const { current, earlier } = useMemo(
    () => splitChapters(detail?.chapters ?? [], runtime.currentChapter?.sessionId),
    [detail, runtime.currentChapter?.sessionId],
  );
  const currentSessionId = runtime.currentChapter?.sessionId ?? current?.sessionId ?? null;
  // Viewing the current chapter is the same as not viewing anything else.
  const viewing = viewingSessionId && viewingSessionId !== currentSessionId ? viewingSessionId : null;
  const viewedChapter = viewing ? earlier.find((c) => c.sessionId === viewing) ?? null : null;
  const viewedDelegated = viewing ? detail?.delegated.find((s) => s.sessionId === viewing) ?? null : null;
  const transcriptSessionId = viewing ?? currentSessionId;
  const hiddenCount = showAll ? 0 : Math.max(0, earlier.length - VISIBLE_EARLIER_CHAPTERS);
  const Transcript = host.components?.SessionTranscript;

  return (
    <div className="crew-timeline">
      <div className="crew-timeline-strip">
        {hiddenCount > 0 && (
          <button type="button" className="crew-link-button" onClick={() => setShowAll(true)}>
            Show {hiddenCount} older {hiddenCount === 1 ? 'chapter' : 'chapters'}
          </button>
        )}
        {earlier.slice(hiddenCount).map((chapter) => (
          <CrewChapterCard
            key={chapter.sessionId}
            chapter={chapter}
            reading={chapter.sessionId === viewing}
            onToggle={() => viewSession(slug, chapter.sessionId === viewing ? null : chapter.sessionId)}
          />
        ))}

        {viewing ? (
          <div className="crew-viewing-banner">
            <MaterialSymbol icon="history" size={15} />
            <span className="crew-grow">
              {viewedChapter
                ? `Reading chapter ${viewedChapter.chapterIndex}. Messages sent here go to that chapter, not the current one.`
                : viewedDelegated
                  ? `Reading "${viewedDelegated.name}", a session ${definition.name} started. Messages sent here go to that session.`
                  : `Reading another session. Messages sent here go to that session.`}
            </span>
            {currentSessionId && (
              <button type="button" className="crew-link-button" onClick={() => viewSession(slug, null)}>Back to current chapter</button>
            )}
          </div>
        ) : current ? (
          <div className="crew-chapter-divider">
            Chapter {current.chapterIndex}, started {formatDay(current.startedAt)}
            {runtime.onShift && runtime.shiftTrigger && (
              <span className="crew-wake-marker">
                <MaterialSymbol icon="alarm" size={13} />
                {describeTrigger(runtime.shiftTrigger)}{runtime.shiftStartedAt ? `, ${formatWhen(runtime.shiftStartedAt)}` : ''}
              </span>
            )}
          </div>
        ) : null}
        {loadError && !detail && <p className="crew-error" role="alert">{loadError}</p>}
      </div>

      <div className="crew-timeline-transcript">
        {!Transcript ? (
          <div className="crew-empty-note">This Nimbalyst build cannot show session transcripts inside extension panels.</div>
        ) : transcriptSessionId ? (
          <Transcript key={transcriptSessionId} sessionId={transcriptSessionId} />
        ) : detail === null && !loadError ? (
          <div className="crew-empty-note" role="status">Loading...</div>
        ) : (
          <CrewFirstShift member={member} />
        )}
      </div>
    </div>
  );
}

function CrewChapterCard({ chapter, reading, onToggle }: { chapter: CrewChapterSummary; reading: boolean; onToggle: () => void }) {
  return (
    <div className="crew-chapter-card" data-reading={reading} data-chapter-index={chapter.chapterIndex}>
      <MaterialSymbol icon={reading ? 'expand_more' : 'chevron_right'} size={16} />
      <div className="crew-grow">
        <div className="crew-chapter-card-title">
          Chapter {chapter.chapterIndex}
          <span className="crew-faint"> {formatDateRange(chapter.startedAt, chapter.endedAt)}</span>
          {chapter.endReason && <span className="crew-faint">, {chapter.endReason}</span>}
        </div>
        {chapter.handoffSummary && (
          <p className="crew-chapter-card-summary crew-selectable" data-expanded={reading}>Handoff: {chapter.handoffSummary}</p>
        )}
      </div>
      <button type="button" className="crew-link-button" onClick={onToggle}>
        {reading ? 'Close chapter' : 'Read chapter'}
      </button>
    </div>
  );
}

/** No chapter yet: the first shift is what creates one, and its transcript. */
function CrewFirstShift({ member }: { member: CrewMemberSnapshot }) {
  const { client } = useCrew();
  const { busy, error, run } = useCrewAction();
  const [prompt, setPrompt] = useState('');
  const { definition } = member;
  const shift = deriveShiftAction(member);
  const blocked = shift.kind === 'start' ? shift.blockedReason : undefined;

  const start = async () => {
    const started = await run('start', () => client.call('startShift', { slug: definition.slug, prompt: prompt.trim() || undefined }));
    if (started) setPrompt('');
  };

  return (
    <div className="crew-first-shift">
      <div className="crew-first-shift-inner">
        <p className="crew-muted">
          {definition.name} has not worked a shift yet. Start one now, optionally with a first task, or wait for the schedule.
        </p>
        <textarea
          className="crew-input crew-textarea"
          placeholder={`What should ${definition.name} look at first?`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && !blocked) {
              e.preventDefault();
              void start();
            }
          }}
          disabled={busy !== null}
        />
        <div className="crew-row">
          <button type="button" className="crew-btn crew-btn-primary" disabled={busy !== null || blocked !== undefined} onClick={() => void start()}>
            Start first shift
          </button>
          {blocked && <span className="crew-faint">{blocked}</span>}
        </div>
        <CrewError message={error} />
      </div>
    </div>
  );
}
