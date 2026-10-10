/**
 * Queries against the TeamRoom's page links index (`pageLinksQuery` ->
 * `pageLinksResponse`), matched by request id so several can be in flight.
 * A query is a read: it is never queued offline, and it answers null when the
 * socket is down or the server does not reply in time.
 *
 * `changed()` (the server's `pageLinksChanged`, or a team connection coming
 * up) reaches every `onTeamPageLinksChanged` listener, whichever team it came
 * from: an open Links section asks its active team again.
 */

import type {
  TeamPageLinksQueryMessage,
  TeamPageLinksResponseMessage,
} from '@nimbalyst/collab-protocol';

export type TeamPageLinksFilters = Pick<TeamPageLinksQueryMessage, 'projectId' | 'from' | 'to'>;

export type TeamPageLinksResult = Pick<TeamPageLinksResponseMessage, 'outgoing' | 'incoming' | 'status'>;

let nextRequest = 0;
const changeListeners = new Set<() => void>();

/** Called when a team's page links may have changed; returns the unsubscribe. */
export function onTeamPageLinksChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export class TeamPageLinksRequests {
  /** The server said links changed, or the connection came (back) up. */
  changed(): void {
    for (const listener of [...changeListeners]) listener();
  }

  private readonly pending = new Map<string, { resolve: (result: TeamPageLinksResult | null) => void; timer: ReturnType<typeof setTimeout> }>();

  /** `send` returns false when the message could not go out. */
  request(send: (message: TeamPageLinksQueryMessage) => boolean, filters: TeamPageLinksFilters, timeoutMs: number): Promise<TeamPageLinksResult | null> {
    const requestId = `links-${Date.now().toString(36)}-${(nextRequest++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, null), timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      if (!send({ type: 'pageLinksQuery', requestId, ...filters })) this.settle(requestId, null);
    });
  }

  receive(message: TeamPageLinksResponseMessage): void {
    this.settle(message.requestId, { outgoing: message.outgoing, incoming: message.incoming, status: message.status });
  }

  /** Every open query answers null (disconnect, destroy). */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, null);
  }

  private settle(requestId: string, result: TeamPageLinksResult | null): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }
}
