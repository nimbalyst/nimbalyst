/**
 * Whether a new session-room socket may open, and what has to close first.
 *
 * The desktop holds one socket per session room and keeps it until the session
 * has been quiet for `idleEvictMs`. With more than `cap` agents running at once
 * every slot is busy, so a new session is refused. That refusal is a real
 * outcome: callers must surface it (see `SessionConnectionRefusedError`) and
 * send through a short-lived socket instead, never treat it as connected.
 */

/** Hard limit on concurrent session-room sockets per client. */
export const MAX_SESSION_CONNECTIONS = 10;

/** How long a session-room socket must be quiet before a new session may take its slot. */
export const IDLE_EVICTION_TIMEOUT_MS = 5 * 60 * 1000;

export type SessionAdmission =
  | { kind: 'admit' }
  | { kind: 'evict-then-admit'; evictSessionId: string; idleMs: number }
  | { kind: 'refuse' };

export function decideSessionAdmission(
  open: Iterable<[sessionId: string, connection: { lastActivity: number }]>,
  now: number,
  cap: number = MAX_SESSION_CONNECTIONS,
  idleEvictMs: number = IDLE_EVICTION_TIMEOUT_MS,
): SessionAdmission {
  let count = 0;
  let oldestId: string | null = null;
  let oldestActivity = Infinity;
  for (const [sessionId, { lastActivity }] of open) {
    count++;
    if (now - lastActivity >= idleEvictMs && lastActivity < oldestActivity) {
      oldestActivity = lastActivity;
      oldestId = sessionId;
    }
  }
  if (count < cap) return { kind: 'admit' };
  if (oldestId === null) return { kind: 'refuse' };
  return { kind: 'evict-then-admit', evictSessionId: oldestId, idleMs: now - oldestActivity };
}

export const SESSION_CONNECTION_CAP = 'SESSION_CONNECTION_CAP';

/** Thrown by `connect()` when every session-room slot is busy. Retryable once a slot frees. */
export class SessionConnectionRefusedError extends Error {
  readonly code = SESSION_CONNECTION_CAP;
  readonly retryable = true;

  constructor(sessionId: string, cap: number) {
    super(`Session connection refused for ${sessionId}: all ${cap} session connections are busy`);
    this.name = 'SessionConnectionRefusedError';
  }
}

export function isSessionConnectionRefused(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === SESSION_CONNECTION_CAP;
}
