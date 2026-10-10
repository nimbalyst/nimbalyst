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
import type { TeamPageLinksQueryMessage, TeamPageLinksResponseMessage } from '@nimbalyst/collab-protocol';
export type TeamPageLinksFilters = Pick<TeamPageLinksQueryMessage, 'projectId' | 'from' | 'to'>;
export type TeamPageLinksResult = Pick<TeamPageLinksResponseMessage, 'outgoing' | 'incoming' | 'status'>;
/** Called when a team's page links may have changed; returns the unsubscribe. */
export declare function onTeamPageLinksChanged(listener: () => void): () => void;
export declare class TeamPageLinksRequests {
    /** The server said links changed, or the connection came (back) up. */
    changed(): void;
    private readonly pending;
    /** `send` returns false when the message could not go out. */
    request(send: (message: TeamPageLinksQueryMessage) => boolean, filters: TeamPageLinksFilters, timeoutMs: number): Promise<TeamPageLinksResult | null>;
    receive(message: TeamPageLinksResponseMessage): void;
    /** Every open query answers null (disconnect, destroy). */
    cancelAll(): void;
    private settle;
}
