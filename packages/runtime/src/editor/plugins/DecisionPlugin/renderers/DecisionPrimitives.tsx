/**
 * Row chrome shared by the select-shaped ask types.
 *
 * These reproduce the transcript's option row rather than importing it. The
 * transcript's `WidgetOptionRow` has no slot for a share bar, a vote count, or
 * an avatar stack, and widening it would change a surface this feature does not
 * own. What is preserved is the thing that actually matters for familiarity:
 * the same indicator geometry, the same label-over-description body, the same
 * click target. `ReorderList` needs none of this and is imported verbatim.
 *
 * The row is one component across both states on purpose. Flipping between a
 * "control" row and a separate "result" row would move the label under the
 * cursor at the moment of answering; instead the same row grows a fill bar and
 * a tally.
 */

import React from 'react';
import type { DecisionMember } from '../../../decisions/types';

/** Stable per-person tint, so the same voter is the same color across blocks. */
function avatarTone(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % 6;
}

function initialFor(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

export const Avatar: React.FC<{ id: string; name: string; size?: 'xs' | 'sm' }> = ({
  id,
  name,
  size = 'xs',
}) => (
  <span
    className={`decision-av decision-av--${size} decision-av--tone${avatarTone(id)}`}
    title={name}
    aria-hidden="true"
  >
    {initialFor(name)}
  </span>
);

export const AvatarStack: React.FC<{
  voterIds: readonly string[];
  members: readonly DecisionMember[];
  max?: number;
}> = ({ voterIds, members, max = 4 }) => {
  if (voterIds.length === 0) return null;
  const nameFor = (id: string): string =>
    members.find((member) => member.id === id)?.name ?? id;
  const shown = voterIds.slice(0, max);
  const overflow = voterIds.length - shown.length;

  return (
    <span className="decision-stack">
      {shown.map((id) => (
        <Avatar key={id} id={id} name={nameFor(id)} />
      ))}
      {overflow > 0 ? <span className="decision-av-more">+{overflow}</span> : null}
    </span>
  );
};

const CheckMark: React.FC = () => (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path
      d="M8.5 2.5 3.75 7.25 1.5 5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export interface DecisionRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  badge?: string;
  /** `radio` for a single choice, `check` for a multiple one. */
  indicator: 'radio' | 'check';
  selected: boolean;
  /** Omit for a read-only row. */
  onSelect?: () => void;
  disabled?: boolean;
  /** Marks the row as the viewer's own answer once they have answered. */
  isMine?: boolean;
  /** Present only when the tally is visible to this viewer. */
  tally?: {
    voterIds: readonly string[];
    count: number;
    share: number;
    members: readonly DecisionMember[];
  };
  /** Artifact preview, rendered above the row body when the entry carries one. */
  preview?: React.ReactNode;
  testId?: string;
}

export const DecisionRow: React.FC<DecisionRowProps> = ({
  label,
  description,
  badge,
  indicator,
  selected,
  onSelect,
  disabled,
  isMine,
  tally,
  preview,
  testId,
}) => {
  const interactive = Boolean(onSelect) && !disabled;
  const className = [
    'decision-row',
    selected ? 'decision-row--selected' : '',
    isMine ? 'decision-row--mine' : '',
    interactive ? '' : 'decision-row--static',
  ]
    .filter(Boolean)
    .join(' ');

  const body = (
    <>
      {tally ? (
        <span
          className="decision-row-fill"
          style={{ width: `${Math.round(tally.share * 100)}%` }}
          aria-hidden="true"
        />
      ) : null}
      <span className="decision-row-inner">
        <span
          className={`decision-box decision-box--${indicator}${
            selected ? ' decision-box--on' : ''
          }`}
          aria-hidden="true"
        >
          {selected ? <CheckMark /> : null}
        </span>
        <span className="decision-row-main">
          <span className="decision-row-title-line">
            <span className="decision-row-title">{label}</span>
            {badge ? <span className="decision-entry-badge">{badge}</span> : null}
            {isMine ? <span className="decision-you">You</span> : null}
          </span>
          {description ? (
            <span className="decision-row-sub">{description}</span>
          ) : null}
        </span>
        {tally ? (
          <span className="decision-row-tally">
            <AvatarStack voterIds={tally.voterIds} members={tally.members} />
            <span className="decision-row-count">{tally.count}</span>
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <div className="decision-row-wrap">
      {preview ? <div className="decision-row-preview">{preview}</div> : null}
      {interactive ? (
        <button
          type="button"
          className={className}
          onClick={onSelect}
          aria-pressed={selected}
          data-testid={testId}
        >
          {body}
        </button>
      ) : (
        <div className={className} data-testid={testId}>
          {body}
        </div>
      )}
    </div>
  );
};

/**
 * The block's footer.
 *
 * Carries the two facts a reader needs without opening anything: how far along
 * the answering is, and whether they personally still owe an answer.
 */
export const DecisionFooter: React.FC<{
  left: React.ReactNode;
  children?: React.ReactNode;
}> = ({ left, children }) => (
  <div className="decision-foot">
    {left}
    <span className="decision-grow" />
    {children}
  </div>
);

export const AnsweredMark: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="decision-answered-mark">
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.3 12 13 4.5" />
    </svg>
    {children}
  </span>
);

/**
 * Shown instead of the tally when the ask hides results until you answer.
 *
 * The count of respondents is still shown -- knowing that three people have
 * answered does not bias what you pick, but seeing what they picked does.
 */
export const HiddenTallyNote: React.FC<{ count: number; noun: string }> = ({
  count,
  noun,
}) => (
  <span className="decision-blind">
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
      {`${count} ${noun} — results hidden until you answer`}
  </span>
);
