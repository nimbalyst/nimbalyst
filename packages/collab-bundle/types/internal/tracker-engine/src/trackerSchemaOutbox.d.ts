/**
 * The push side of the schema lane: offer every locally-changed schema row to
 * the room.
 *
 * Runs at the end of every bootstrap and, since NIM-6654, whenever the host
 * reports a schema save while connected. Before that the only trigger was the
 * bootstrap, so an edit made mid-session sat at `pending` until the socket
 * happened to drop.
 *
 * Two runs can overlap -- a save lands while the post-bootstrap drain is still
 * awaiting `listUnsynced` -- and a row stays in the host's outbox until its ack
 * is applied. So the outbox remembers what it has sent and not yet heard back
 * about, and does not send the same content for the same type twice. Changed
 * content for a type already in flight is sent: the room orders the two by
 * arrival, and the later one is the one the author meant.
 */
import type { TrackerClientMessage } from './trackerProtocol.js';
import type { TrackerSchemaSyncHooks } from './TrackerSyncEngine.js';
export interface TrackerSchemaOutboxDeps {
    hooks: () => TrackerSchemaSyncHooks | undefined;
    isOpen: () => boolean;
    send: (message: TrackerClientMessage) => void;
    newMutationId: () => string;
    /** The engine's cmid -> lane id map, which rejection acks are resolved through. */
    pendingLaneIds: Map<string, string>;
    /** Whether the room advertised that it refuses a create-only mutation for an existing type. */
    createOnlySupported: () => boolean;
}
export declare class TrackerSchemaOutbox {
    private readonly deps;
    /** clientMutationId -> the type and payload that mutation carried. */
    private readonly inFlight;
    private running;
    private rerun;
    constructor(deps: TrackerSchemaOutboxDeps);
    /** Push what the host has queued. Concurrent calls coalesce into one follow-up run. */
    push(): Promise<void>;
    /** The room answered this mutation, either way. Returns what it carried, if it was ours. */
    settle(clientMutationId: string): {
        type: string;
        model: string | null;
    } | undefined;
    /** A new socket means nothing sent on the old one will be acked. */
    reset(): void;
    private isInFlight;
    private pushOnce;
}
