import type { TeamJwt, TeamMemberId } from '../../../../runtime/src/auth/jwtScopes';
import type { TrackerIdentity } from '../../../../runtime/src/core/DocumentService';
import { IndexedDbTrackerPersistence } from '@nimbalyst/tracker-engine';
import { type TrackerItemPayload } from '@nimbalyst/tracker-engine';
import { type TrackerNavigationSyncHooks, type TrackerPresenceIdentity, type TrackerSchemaSyncHooks } from '@nimbalyst/tracker-engine';
import type { TrackerAccessTermination } from '@nimbalyst/tracker-engine';
import type { TrackerDataChange, TrackerDataCommand, TrackerDataCommandResult, TrackerDataSnapshot, TrackerDataSource, TrackerSyncState, TrackerItemRevisionRecord, TrackerRevisionRef } from '../dataSource';
import { type TrackerBodyRoom, type TrackerBodySeeder } from './trackerBodyRoom';
export interface BrowserTrackerDataSourceOptions {
    workspacePath: string;
    serverUrl: string;
    orgId: string;
    teamProjectId: string;
    teamMemberId: TeamMemberId;
    currentUser: TrackerIdentity;
    /** Display identity from the team roster. Do not derive this from email. */
    presenceIdentity: TrackerPresenceIdentity;
    getTeamJwt: () => Promise<TeamJwt>;
    databaseName?: string;
    indexedDbFactory?: IDBFactory;
    persistence?: IndexedDbTrackerPersistence;
    schemaSync?: TrackerSchemaSyncHooks;
    navigationSync?: TrackerNavigationSyncHooks;
    initializeIssueKeyPrefix?: string;
    /** Browser hosts omit this; local harnesses may inject a socket implementation. */
    createWebSocket?: (url: string) => WebSocket;
    /** Test seam for a harness that has no HTTP worker in front of its fake room. */
    authorizeRoom?: (jwt: TeamJwt) => Promise<TrackerAccessTermination | null>;
    /** Test seam for the item body's document room; defaults to a `DocumentSyncProvider`. */
    openTrackerBodyRoom?: (documentId: string) => TrackerBodyRoom;
    /**
     * Writes a new item's description into its body room. Injected by the host
     * from the `./editor` entry (`seedTrackerBody`) because it carries the
     * Markdown/Lexical codec, which `trackers-ui` must not reach. Without it,
     * creating an item with a body fails rather than dropping the body.
     */
    seedTrackerBody?: TrackerBodySeeder;
    /**
     * Decide whether a failure to mint a team JWT is terminal, and say which
     * terminal thing it is. Return null for anything retryable.
     *
     * Without it, an expired session is indistinguishable from a flaky network:
     * the engine retries with backoff, the surface shows "offline", and the
     * reader is never told to sign in -- the documented first thing to check when
     * a second client cannot see shared data. Left unset, every token failure
     * stays on the retry path, which is the right default for a host whose auth
     * errors it cannot classify.
     */
    classifyAuthFailure?: (error: unknown) => TrackerAccessTermination | null;
    reportError?: (error: unknown, context: string) => void;
}
/** Purge a room cache even when authorization fails before a data source mounts. */
export declare function purgeBrowserTrackerRoom(orgId: string, teamProjectId: string, indexedDbFactory?: IDBFactory): Promise<void>;
/** Purge every cached tracker project for a removed organization member. */
export declare function purgeBrowserTrackerOrganization(orgId: string, indexedDbFactory?: IDBFactory): Promise<void>;
/** Purge all tracker data when the browser team session itself is gone. */
export declare function purgeAllBrowserTrackerData(indexedDbFactory?: IDBFactory): Promise<void>;
/**
 * `labels` is the item's add-wins label set, not a field: reads project it
 * from `payload.labels` over whatever `fields.labels` says, so an update must
 * diff into the set or it is lost on the next read.
 */
export declare function updatePayload(payload: TrackerItemPayload, updates: Record<string, unknown>, currentUser: TrackerIdentity): TrackerItemPayload;
export declare class BrowserTrackerDataSource implements TrackerDataSource {
    private readonly options;
    private readonly persistence;
    private readonly engine;
    private readonly listeners;
    private syncState;
    /** Cached projections stay sealed until the current member passes the room gate. */
    private authorized;
    private disposed;
    private get transactionOwner();
    constructor(options: BrowserTrackerDataSourceOptions);
    snapshot(): Promise<TrackerDataSnapshot>;
    subscribe(cb: (change: TrackerDataChange) => void): () => void;
    status(): TrackerSyncState;
    /** Push the schema lane now; before bootstrap finishes, the bootstrap pushes it. */
    flushSchemas(): Promise<void>;
    /**
     * Not available in the browser yet, and it throws rather than approximating.
     *
     * The IndexedDB persistence keeps only current rows: N6 left browser-side
     * revisions out on purpose, because the room owns `serverRevision` and the
     * browser's half of that lands with the collab server's revision read (C2).
     * Answering with the live item instead would silently show newer evidence
     * under a pinned citation, which is the one failure contract 4.2 exists to
     * prevent.
     */
    getItemRevision(_itemId: string, _ref: TrackerRevisionRef): Promise<TrackerItemRevisionRecord>;
    command(command: TrackerDataCommand): Promise<TrackerDataCommandResult>;
    dispose(): void;
    private updateOne;
    private updateMany;
    private updateExisting;
    private openTrackerBodyRoom;
    private upsert;
    private readItems;
    private readSavedViews;
    private emitAppliedItem;
    private emitSavedViews;
    /**
     * A plain GET reaches the exact worker authorization gate used by the
     * WebSocket upgrade. Authorized requests continue to TrackerRoom and answer
     * 400 "Expected WebSocket"; 401/403 are returned before a socket exists.
     */
    private authorizeRoom;
    private emitAuthorizedProjection;
    private handleAccessTerminated;
    private setSyncState;
    private emit;
    private assertActive;
    private assertAuthorized;
    private savedViewBelongsToCurrentMember;
}
