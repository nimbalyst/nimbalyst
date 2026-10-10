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
import type { PageMarkEntry, TeamPageMarksQueryMessage, TeamPageMarksResponseMessage } from '@nimbalyst/collab-protocol';
export type TeamPageMarksFilters = Pick<TeamPageMarksQueryMessage, 'kind' | 'email' | 'documentIds' | 'projectId'>;
export interface TeamPageMarksResult {
    marks: PageMarkEntry[];
    status: TeamPageMarksResponseMessage['status'];
    coverage?: TeamPageMarksResponseMessage['coverage'];
}
/** Called when a team's marks may have changed; returns the unsubscribe. */
export declare function onTeamPageMarksChanged(listener: () => void): () => void;
export declare class TeamPageMarksRequests {
    /** The server said marks changed, or the connection came (back) up. */
    changed(): void;
    private readonly pending;
    /** `send` returns false when the message could not go out. */
    request(send: (message: TeamPageMarksQueryMessage) => boolean, filters: TeamPageMarksFilters, timeoutMs: number): Promise<TeamPageMarksResult | null>;
    receive(message: TeamPageMarksResponseMessage): void;
    /** Every open query answers null (disconnect, destroy). */
    cancelAll(): void;
    private settle;
}
