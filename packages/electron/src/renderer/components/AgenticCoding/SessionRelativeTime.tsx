import React, { memo, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { sessionLastActivityAtom } from '../../store';
import { getRelativeTimeString } from '../../utils/dateFormatting';

interface SessionRelativeTimeProps {
  sessionId: string;
  /** Fallback timestamp from the registry, used until activity is recorded. */
  fallbackTimestamp: number;
}

/**
 * Renders a session's "5m ago" label and subscribes to its per-id activity
 * atom so the label can tick during streaming without re-rendering the
 * parent list. See `sessionLastActivityAtom` for the design.
 */
export const SessionRelativeTime = memo<SessionRelativeTimeProps>(({
  sessionId,
  fallbackTimestamp,
}) => {
  const liveActivity = useAtomValue(sessionLastActivityAtom(sessionId));
  const timestamp = liveActivity > 0 ? liveActivity : fallbackTimestamp;

  // A quiet session still ages, so re-render once a minute (the finest
  // granularity getRelativeTimeString renders). Without this the label froze
  // at its last render, e.g. "Just now" long after the turn ended (#1200).
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  return <>{getRelativeTimeString(timestamp)}</>;
});

SessionRelativeTime.displayName = 'SessionRelativeTime';
