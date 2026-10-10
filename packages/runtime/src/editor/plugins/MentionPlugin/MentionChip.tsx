/**
 * The rendered mention: a person chip (name, email on hover, mailto on click)
 * or a date chip (relative label, the full date on hover). The relative label
 * re-renders at midnight so "tomorrow" becomes "today" on a page left open.
 */

import React, { useEffect, useState } from 'react';

import { formatAbsoluteDate, formatRelativeDate } from './mentionDates';
import type { MentionKind } from './MentionNodeCore';

function msUntilMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime() + 1000;
}

function useToday(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msUntilMidnight(now));
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}

function DateChip({ iso }: { iso: string }): React.JSX.Element {
  const now = useToday();
  return (
    <time className="mention-chip mention-chip--date rounded px-1 text-nim-link bg-nim-secondary" dateTime={iso} title={formatAbsoluteDate(iso)}>
      @{formatRelativeDate(iso, now)}
    </time>
  );
}

function PersonChip({ email, name }: { email: string; name: string }): React.JSX.Element {
  return (
    <a
      className="mention-chip mention-chip--person rounded px-1 text-nim-link bg-nim-secondary no-underline"
      href={`mailto:${email}`}
      title={email}
      onClick={(event) => {
        // A click in the editor selects the chip; open mail only on a modifier click.
        if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      }}
    >
      @{name || email}
    </a>
  );
}

export function MentionChip({ kind, value, label }: { kind: MentionKind; value: string; label: string }): React.JSX.Element {
  return kind === 'date' ? <DateChip iso={value} /> : <PersonChip email={value} name={label} />;
}
