import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FloatingPortal, useFloating, autoUpdate, flip, offset, shift, type ReferenceElement } from '@floating-ui/react';

import type { MentionCandidate } from './commentViewModel';

/**
 * One picker, one trigger.
 *
 * A single `@` opens this list containing both people and agents. Agents are a
 * visually distinct group inside it rather than behind a second trigger
 * character, because a second character is a thing to memorize and the
 * consequence of getting it wrong (dispatching work to a session, or failing
 * to) is not obvious until after the message posts.
 *
 * Agent rows are absent, not disabled, when the room's `agentPostingEnabled` is
 * off or the session is not attached to this conversation -- that filtering
 * happens in `mentionCandidates`, so this component never has to know the rule.
 */
export function MentionPicker({
  anchorRect,
  candidates,
  activeIndex,
  onSelect,
  onActiveIndexChange,
}: {
  /** Caret rectangle, or the composer's own rect when the caret is unmeasurable. */
  anchorRect: DOMRect | null;
  candidates: MentionCandidate[];
  activeIndex: number;
  onSelect: (candidate: MentionCandidate) => void;
  onActiveIndexChange: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const virtualReference = useMemo<ReferenceElement>(
    () => ({
      getBoundingClientRect: () => anchorRect ?? new DOMRect(0, 0, 0, 0),
    }),
    [anchorRect],
  );

  const { refs, floatingStyles } = useFloating({
    placement: 'top-start',
    // Fixed matches the rest of the app's floating surfaces and survives a
    // scrolling ancestor; autoUpdate keeps it pinned while the timeline moves.
    strategy: 'fixed',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // Virtual references go through setPositionReference, not `elements`.
  useLayoutEffect(() => {
    refs.setPositionReference(virtualReference);
  }, [refs, virtualReference]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (candidates.length === 0) return null;

  const firstAgentIndex = candidates.findIndex((candidate) => candidate.kind === 'agent');

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        role="listbox"
        aria-label="Mention a person or agent"
        data-testid="mention-picker"
        className="mention-picker z-[10000] max-h-[260px] w-[280px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1 shadow-[0_6px_18px_rgba(0,0,0,0.22)]"
      >
        <div ref={listRef}>
          {candidates[0]?.kind === 'person' && (
            <GroupLabel testId="mention-group-people" label="People" />
          )}

          {candidates.map((candidate, index) => (
            <React.Fragment key={candidate.kind === 'person' ? `p:${candidate.person.userId}` : `a:${candidate.agent.sessionId}`}>
              {index === firstAgentIndex && firstAgentIndex >= 0 && (
                <GroupLabel testId="mention-group-agents" label="Agents in this conversation" separated={index > 0} />
              )}
              <CandidateRow
                candidate={candidate}
                active={index === activeIndex}
                onSelect={() => onSelect(candidate)}
                onHover={() => onActiveIndexChange(index)}
              />
            </React.Fragment>
          ))}
        </div>
      </div>
    </FloatingPortal>
  );
}

function GroupLabel({ label, testId, separated }: { label: string; testId: string; separated?: boolean }) {
  return (
    <div
      data-testid={testId}
      className={`mention-picker-group-label px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] ${
        separated ? 'mt-1 border-t border-[var(--nim-border)] pt-2' : 'pt-1'
      }`}
    >
      {label}
    </div>
  );
}

function CandidateRow({
  candidate,
  active,
  onSelect,
  onHover,
}: {
  candidate: MentionCandidate;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const shared = `mention-picker-option flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
    active ? 'bg-[var(--nim-bg-selected)]' : 'bg-transparent hover:bg-[var(--nim-bg-hover)]'
  }`;

  if (candidate.kind === 'person') {
    const { person } = candidate;
    return (
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-active={active ? 'true' : 'false'}
        data-testid={`mention-option-person-${person.userId}`}
        className={shared}
        onMouseEnter={onHover}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelect}
      >
        <span className="mention-picker-avatar flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--nim-bg-active)] text-[10px] font-semibold text-[var(--nim-text-muted)]">
          {person.avatarInitials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="mention-picker-name block truncate text-[13px] text-[var(--nim-text)]">
            {person.displayName}
          </span>
          <span className="mention-picker-handle block truncate text-[11px] text-[var(--nim-text-faint)]">
            @{person.handle}
            {person.subtitle ? ` · ${person.subtitle}` : ''}
          </span>
        </span>
      </button>
    );
  }

  const { agent } = candidate;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active ? 'true' : 'false'}
      data-testid={`mention-option-agent-${agent.sessionId}`}
      className={shared}
      onMouseEnter={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      <span
        className="mention-picker-agent-glyph flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)] text-[var(--nim-primary)]"
        data-testid="mention-option-agent-glyph"
        aria-label="Agent"
      >
        <MaterialSymbol icon="smart_toy" size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="mention-picker-name block truncate text-[13px] text-[var(--nim-text)]">
          {agent.sessionName}
        </span>
        <span className="mention-picker-handle block truncate text-[11px] text-[var(--nim-text-faint)]">
          @{agent.handle} · session of {agent.ownerDisplayName}
        </span>
      </span>
    </button>
  );
}
