/**
 * Monotonic per-key request tokens for listeners that both fetch and receive
 * authoritative pushes.
 *
 * Without one, a slow GET issued before a broadcast can resolve after it and
 * overwrite newer state — an admin turns rooms off, the broadcast applies, and
 * a stale settings response turns them back on. Every fetch takes a token
 * before it starts and drops its result unless that token is still the latest;
 * applying a push bumps the sequence so no in-flight fetch can win.
 */
export interface RequestSequence {
  /** Take the next token for `key`, invalidating every earlier one. */
  next(key: string): number;
  /** True while `token` is the most recent one taken for `key`. */
  isLatest(key: string, token: number): boolean;
  /** Invalidate every in-flight request for `key` without taking a token. */
  bump(key: string): void;
}

export function createRequestSequence(): RequestSequence {
  const tokens = new Map<string, number>();
  const next = (key: string): number => {
    const token = (tokens.get(key) ?? 0) + 1;
    tokens.set(key, token);
    return token;
  };
  return {
    next,
    isLatest: (key, token) => (tokens.get(key) ?? 0) === token,
    bump: (key) => { next(key); },
  };
}
