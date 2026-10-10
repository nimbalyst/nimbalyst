/**
 * Queries against the TeamRoom's marks index (`pageMarksQuery` ->
 * `pageMarksResponse`), matched by request id so several can be in flight.
 * A query is a read: it is never queued offline, and it answers null when the
 * socket is down or the server does not reply in time.
 *
 * `changed()` (the server's `pageMarksChanged`, or a team connection coming
 * up) reaches every `onTeamPageMarksChanged` listener, whichever team it came
 * from: a marks source asks its active team again.
 */

import type {
  PageMarkEntry,
  TeamPageMarksQueryMessage,
  TeamPageMarksResponseMessage,
} from '@nimbalyst/collab-protocol';

export type TeamPageMarksFilters = Pick<TeamPageMarksQueryMessage, 'kind' | 'email' | 'documentIds' | 'projectId'>;

export interface TeamPageMarksResult {
  marks: PageMarkEntry[];
  status: TeamPageMarksResponseMessage['status'];
  coverage?: TeamPageMarksResponseMessage['coverage'];
}

let nextRequest = 0;
const changeListeners = new Set<() => void>();

/** Called when a team's marks may have changed; returns the unsubscribe. */
export function onTeamPageMarksChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export class TeamPageMarksRequests {
  /** The server said marks changed, or the connection came (back) up. */
  changed(): void {
    for (const listener of [...changeListeners]) listener();
  }

  private readonly pending = new Map<string, { resolve: (result: TeamPageMarksResult | null) => void; timer: ReturnType<typeof setTimeout> }>();

  /** `send` returns false when the message could not go out. */
  request(send: (message: TeamPageMarksQueryMessage) => boolean, filters: TeamPageMarksFilters, timeoutMs: number): Promise<TeamPageMarksResult | null> {
    const requestId = `marks-${Date.now().toString(36)}-${(nextRequest++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, null), timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      if (!send({ type: 'pageMarksQuery', requestId, ...filters })) this.settle(requestId, null);
    });
  }

  receive(message: TeamPageMarksResponseMessage): void {
    this.settle(message.requestId, { marks: message.marks, status: message.status, ...(message.coverage ? { coverage: message.coverage } : {}) });
  }

  /** Every open query answers null (disconnect, destroy). */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, null);
  }

  private settle(requestId: string, result: TeamPageMarksResult | null): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }
}
