/**
 * Records the revisions a shared page's history is made of. The server never
 * takes a snapshot on its own; an open editor posts them:
 *
 *   - `bootstrap` once, when the room has no revisions yet;
 *   - `auto` after the content has been idle for a while and is not already
 *     the latest recorded revision.
 *
 * Only while the page is connected and writable. Shared by the desktop's page
 * bodies that are not a collaborative tab (a typed page's body, a type page's
 * prose) and every page the web console mounts; the desktop's collaborative
 * tab runs the same loop in `CollaborativeTabEditor`. Two clients recording
 * the same content inside the server's dedupe window collapse into one
 * revision.
 */
import type { CollabHistoryController } from './collabHistoryController';
export declare const AUTO_REVISION_POLL_MS = 30000;
export declare const AUTO_REVISION_IDLE_MS = 60000;
export declare const AUTO_REVISION_MIN_INTERVAL_MS: number;
export declare class CollabRevisionRecorder {
    private readonly controller;
    private readonly now;
    private bootstrapEnsured;
    private running;
    private lastObservedHash;
    private lastObservedAt;
    private lastRecordedHash;
    private lastAutoAt;
    constructor(controller: CollabHistoryController, now?: () => number);
    /** One pass: bootstrap the history if needed, else record an idle change. Never throws. */
    tick(): Promise<void>;
    private ensureBootstrap;
    private snapshot;
    private create;
}
/**
 * Record a mounted page's revisions until the returned stop is called: one
 * pass now, then one every {@link AUTO_REVISION_POLL_MS}.
 */
export declare function startCollabRevisionRecording(controller: CollabHistoryController, options?: {
    now?: () => number;
    pollMs?: number;
}): () => void;
