/**
 * SessionReferenceChip — inline chip for a reference to another AI session.
 *
 * Resolves the session's live title + phase from `sessionRefByIdAtom` and opens
 * it on click via the `open-ai-session` window event. When the id can't be
 * resolved (unknown / not yet loaded), it degrades to a muted pill showing a
 * shortened id — it never throws and never blocks rendering.
 *
 * Session analog of `TrackerReferenceChip`.
 */

import type { JSX } from 'react';
import * as React from 'react';
import { useAtomValue } from 'jotai';

import {
  sessionRefByIdAtom,
  openSessionReference,
  type SessionRefMeta,
} from './sessionRefAtoms';

/** Phase -> presentation. Falls back to neutral for unknown phases. */
const PHASE_PRESENTATION: Record<string, { color: string; label: string }> = {
  backlog: { color: 'var(--nim-text-muted)', label: 'Backlog' },
  planning: { color: 'var(--nim-info)', label: 'Planning' },
  implementing: { color: 'var(--nim-warning)', label: 'Implementing' },
  validating: { color: 'var(--nim-info)', label: 'Validating' },
  complete: { color: 'var(--nim-success)', label: 'Complete' },
};

/** Short, stable id label for the unresolved / fallback state. */
export function shortSessionId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function statusDotColor(meta: SessionRefMeta | null): string {
  if (!meta) return 'var(--nim-text-faint)';
  if (meta.isAwaitingInput) return 'var(--nim-warning)';
  if (meta.isProcessing) return 'var(--nim-info)';
  if (meta.phase && PHASE_PRESENTATION[meta.phase]) {
    return PHASE_PRESENTATION[meta.phase].color;
  }
  return 'var(--nim-text-muted)';
}

export interface SessionReferenceChipProps {
  sessionId: string;
  /** Compact chips drop the phase label, keeping the icon + title. */
  variant?: 'default' | 'compact';
}

export function SessionReferenceChip({
  sessionId,
  variant = 'default',
}: SessionReferenceChipProps): JSX.Element {
  const meta = useAtomValue(sessionRefByIdAtom(sessionId));

  const label = meta?.title?.trim() || shortSessionId(sessionId);
  const dotColor = statusDotColor(meta);
  const phase =
    meta?.phase && PHASE_PRESENTATION[meta.phase]
      ? PHASE_PRESENTATION[meta.phase].label
      : undefined;
  const tooltip = meta
    ? `${meta.title || 'Session'}${phase ? ` · ${phase}` : ''} — open session`
    : `Session ${shortSessionId(sessionId)} — open session`;

  const onOpen = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      openSessionReference(sessionId);
    },
    [sessionId],
  );

  return (
    <button
      type="button"
      onClick={onOpen}
      className="session-reference-chip"
      data-session-id={sessionId}
      data-resolved={meta ? 'true' : 'false'}
      data-phase={meta?.phase}
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 7px',
        height: '20px',
        borderRadius: '10px',
        fontSize: '0.85em',
        lineHeight: '1.5',
        verticalAlign: 'baseline',
        cursor: 'pointer',
        background: 'var(--nim-bg-secondary)',
        border: '1px solid var(--nim-border)',
        color: 'var(--nim-text)',
        whiteSpace: 'nowrap',
        maxWidth: '40ch',
      }}
    >
      <span
        className="material-symbols-outlined session-reference-chip-icon"
        aria-hidden="true"
        style={{ fontSize: '13px', lineHeight: 1, color: 'var(--nim-text-muted)' }}
      >
        forum
      </span>
      <span
        aria-hidden="true"
        className="session-reference-chip-status"
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span
        className="session-reference-chip-title"
        style={{
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      {phase && variant === 'default' ? (
        <span
          className="session-reference-chip-phase"
          style={{ color: 'var(--nim-text-muted)', fontWeight: 500 }}
        >
          {phase}
        </span>
      ) : null}
    </button>
  );
}
