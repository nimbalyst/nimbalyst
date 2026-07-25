import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, ProviderIcon, type SessionMeta } from '@nimbalyst/runtime';
import {
  agentBubbleStateAtom,
  agentSessionAttentionAtom,
  markSessionReadAtom,
  sessionLastActivityAtom,
} from '../../store';
import { selectSessionActionAtom } from '../../store/actions/sessionHistoryActions';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { HelpTooltip } from '../../help';
import { SessionStatusIndicator } from '../AgenticCoding/SessionListItem';
import { SessionTranscriptPeek } from '../AgenticCoding/SessionTranscriptPeek';

interface AgentSessionsPopoverProps {
  onOpenAgentMode: () => void;
}

type AttentionState = 'awaiting' | 'running' | 'unread';

const STATE_STYLES: Record<AttentionState, { label: string; colorClass: string; dotClass: string }> = {
  awaiting: {
    label: 'Awaiting input',
    colorClass: 'text-nim-warning',
    dotClass: 'bg-[var(--nim-warning)]',
  },
  running: {
    label: 'Running',
    colorClass: 'text-nim-success',
    dotClass: 'bg-[var(--nim-success)]',
  },
  unread: {
    label: 'Unread',
    colorClass: 'text-nim-primary',
    dotClass: 'bg-[var(--nim-primary)]',
  },
};

function AgentSessionAttentionRow({
  session,
  now,
  onSelect,
  isPeekOpen,
  onPeekOpen,
  onPeekToggle,
}: {
  session: SessionMeta;
  now: number;
  onSelect: (sessionId: string) => void;
  isPeekOpen: boolean;
  onPeekOpen: (sessionId: string, reference: HTMLElement) => void;
  onPeekToggle: (sessionId: string, reference: HTMLElement) => void;
}) {
  const liveActivity = useAtomValue(sessionLastActivityAtom(session.id));
  const updatedAt = liveActivity > 0 ? liveActivity : session.updatedAt;
  const model = session.model?.includes(':') ? session.model.split(':')[1] : session.model;
  const rowRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);

  // `now` causes the relative label to refresh while the popover is open.
  void now;

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const handlePeekEnter = useCallback(() => {
    if (isPeekOpen || !rowRef.current) return;
    hoverTimerRef.current = window.setTimeout(() => {
      if (rowRef.current) {
        onPeekOpen(session.id, rowRef.current);
      }
    }, 300);
  }, [isPeekOpen, onPeekOpen, session.id]);

  const handlePeekLeave = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  return (
    <div
      ref={rowRef}
      className="agent-sessions-popover-row flex w-full items-center transition-colors hover:bg-nim-tertiary"
      data-session-id={session.id}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 pr-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-[-2px]"
        onClick={() => onSelect(session.id)}
        data-testid={`agent-sessions-row-${session.id}`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-nim-tertiary text-nim-muted">
          <ProviderIcon provider={session.provider || 'claude'} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-nim">
            {session.title || 'Untitled Session'}
          </span>
          <span className="block truncate text-[11px] text-nim-muted">
            {model || session.provider}
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-nim-faint">
          {getRelativeTimeString(updatedAt)}
        </span>
        <SessionStatusIndicator sessionId={session.id} />
      </button>
      <button
        type="button"
        className={`mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] ${
          isPeekOpen
            ? 'bg-nim-tertiary text-nim'
            : 'text-nim-disabled hover:bg-nim-tertiary hover:text-nim-muted'
        }`}
        title="Preview transcript"
        aria-label={`Preview transcript for ${session.title || 'Untitled Session'}`}
        aria-pressed={isPeekOpen}
        data-testid={`agent-sessions-peek-${session.id}`}
        onMouseEnter={handlePeekEnter}
        onMouseLeave={handlePeekLeave}
        onClick={(event) => {
          event.stopPropagation();
          if (rowRef.current) {
            onPeekToggle(session.id, rowRef.current);
          }
        }}
      >
        <MaterialSymbol icon="chat_bubble_outline" size={12} />
      </button>
    </div>
  );
}

export function AgentSessionsPopover({ onOpenAgentMode }: AgentSessionsPopoverProps) {
  const bubble = useAtomValue(agentBubbleStateAtom);
  const groups = useAtomValue(agentSessionAttentionAtom);
  const selectSession = useSetAtom(selectSessionActionAtom);
  const markSessionRead = useSetAtom(markSessionReadAtom);
  const [now, setNow] = useState(Date.now());
  const [activePeek, setActivePeek] = useState<{
    sessionId: string;
    reference: HTMLElement;
  } | null>(null);
  const menu = useFloatingMenu({
    placement: 'right-end',
    dismiss: {
      outsidePress: (event) => {
        const target = event.target;
        return !(target instanceof Element && target.closest('[data-session-transcript-peek]'));
      },
    },
  });

  useEffect(() => {
    if (!menu.isOpen) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [menu.isOpen]);

  const { isOpen, setIsOpen } = menu;

  useEffect(() => {
    if (bubble.color === null && isOpen) {
      setIsOpen(false);
    }
  }, [bubble.color, isOpen, setIsOpen]);

  const allSections: Array<{ state: AttentionState; sessions: SessionMeta[] }> = [
    { state: 'awaiting', sessions: groups.awaitingInput },
    { state: 'running', sessions: groups.running },
    { state: 'unread', sessions: groups.unread },
  ];
  const sections = allSections.filter((section) => section.sessions.length > 0);

  const total = sections.reduce((sum, section) => sum + section.sessions.length, 0);
  const visibleSessionIds = useMemo(
    () => new Set(sections.flatMap((section) => section.sessions.map((session) => session.id))),
    [groups.awaitingInput, groups.running, groups.unread],
  );

  useEffect(() => {
    if (!isOpen && activePeek) {
      setActivePeek(null);
    }
  }, [activePeek, isOpen]);

  useEffect(() => {
    if (activePeek && !visibleSessionIds.has(activePeek.sessionId)) {
      setActivePeek(null);
    }
  }, [activePeek, visibleSessionIds]);

  const handlePeekOpen = useCallback((sessionId: string, reference: HTMLElement) => {
    setActivePeek({ sessionId, reference });
  }, []);

  const handlePeekToggle = useCallback((sessionId: string, reference: HTMLElement) => {
    setActivePeek((current) => (
      current?.sessionId === sessionId ? null : { sessionId, reference }
    ));
  }, []);

  const handleSelect = (sessionId: string) => {
    setActivePeek(null);
    onOpenAgentMode();
    void selectSession(sessionId);
    menu.setIsOpen(false);
  };

  if (bubble.color === null) return null;

  const bubbleClasses = {
    orange: 'bg-[var(--nim-warning)]',
    green: 'bg-[var(--nim-success)]',
    blue: 'bg-[var(--nim-primary)]',
  }[bubble.color];

  return (
    <>
      <HelpTooltip testId="agent-sessions-bubble" placement="right">
        <button
          ref={menu.refs.setReference}
          {...menu.getReferenceProps()}
          type="button"
          className={`agent-sessions-bubble absolute -right-1.5 -top-1.5 z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-[var(--nim-bg-secondary)] px-1 text-[10px] font-bold leading-none text-white shadow-sm ${bubbleClasses}`}
          onClick={(event) => {
            event.stopPropagation();
            menu.setIsOpen(!menu.isOpen);
          }}
          aria-label={`${bubble.count} ${STATE_STYLES[bubble.color === 'orange' ? 'awaiting' : bubble.color === 'green' ? 'running' : 'unread'].label.toLowerCase()} session${bubble.count === 1 ? '' : 's'}`}
          aria-expanded={menu.isOpen}
          aria-haspopup="menu"
          data-state={bubble.color}
          data-testid="agent-sessions-bubble"
        >
          {bubble.count > 9 ? '9+' : bubble.count}
        </button>
      </HelpTooltip>

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="agent-sessions-popover z-[10000] w-[304px] overflow-y-auto rounded-lg border border-nim bg-nim-secondary shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
            data-testid="agent-sessions-popover"
            data-component="AgentSessionsPopover"
          >
            <div className="flex items-center justify-between border-b border-nim px-3.5 py-2.5">
              <span className="text-[13px] font-semibold text-nim">Sessions</span>
              <span className="text-[11px] text-nim-muted">{total} need attention</span>
            </div>

            <div className="pb-1">
              {sections.map(({ state, sessions }) => {
                const style = STATE_STYLES[state];
                return (
                  <section key={state} className={`agent-sessions-popover-group agent-sessions-popover-group--${state}`}>
                    <div className={`flex items-center justify-between gap-2 px-3.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wide ${style.colorClass}`}>
                      <span className="flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${style.dotClass}`} />
                        <span>{style.label}</span>
                        <span aria-hidden>·</span>
                        <span>{sessions.length}</span>
                      </span>
                      {state === 'unread' && (
                        <button
                          type="button"
                          className="agent-sessions-mark-all-read rounded px-1.5 py-0.5 text-[10.5px] font-medium normal-case tracking-normal text-nim-muted transition-colors hover:bg-nim-tertiary hover:text-nim"
                          onClick={() => groups.unread.forEach((session) => markSessionRead(session.id))}
                          data-testid="agent-sessions-mark-all-read"
                        >
                          Mark all as read
                        </button>
                      )}
                    </div>
                    {sessions.map((session) => (
                      <AgentSessionAttentionRow
                        key={session.id}
                        session={session}
                        now={now}
                        onSelect={handleSelect}
                        isPeekOpen={activePeek?.sessionId === session.id}
                        onPeekOpen={handlePeekOpen}
                        onPeekToggle={handlePeekToggle}
                      />
                    ))}
                  </section>
                );
              })}
            </div>
          </div>
        </FloatingPortal>
      )}

      {menu.isOpen && activePeek && (
        <SessionTranscriptPeek
          key={activePeek.sessionId}
          sessionId={activePeek.sessionId}
          reference={activePeek.reference}
          placement="right-start"
          onClose={() => setActivePeek(null)}
        />
      )}
    </>
  );
}
