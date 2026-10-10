import type { CollabCommand, CollabCommandResult, Unsubscribe } from '@nimbalyst/collab-client/core';
import type { TrackerMutationRejectCode } from '@nimbalyst/collab-protocol';
import type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import type { TrackerAccessTermination } from '@nimbalyst/tracker-engine';

export type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
export type {
  TrackerAccessTermination,
  TrackerAccessTerminationReason,
} from '@nimbalyst/tracker-engine';

export type TrackerSyncStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';

export interface TrackerSyncState {
  workspacePath: string;
  status: TrackerSyncStatus;
  projectId: string | null;
  /**
   * Why the room refused this client, when it did so permanently.
   *
   * `status` alone cannot carry this: `error` is also what a transient server
   * error looks like, and `disconnected` is what a dropped socket looks like,
   * and both of those are being retried. A surface that cannot tell them apart
   * either spins forever on a revocation or claims a network blip is a
   * permission problem. When this is set, no reconnect is pending and none
   * will be attempted.
   *
   * Optional so a host that cannot observe refusals -- the desktop IPC data
   * source, which sees only the status string -- keeps satisfying the contract.
   */
  access?: TrackerAccessTermination | null;
  /**
   * The reconnect drain refused to run, so team items are not syncing.
   *
   * Like `access`, this cannot ride on `status`: the socket is fine and the
   * status is `connected`. Only the drain declined, because it could not
   * resolve the sharing policy and would otherwise have deleted previously
   * shared items from the room on a guess (NIM-2968).
   *
   * Cleared by the next drain that runs to completion, so a transient
   * resolution failure self-heals rather than sticking.
   */
  drainHold?: TrackerDrainHold | null;
}

/** Why the reconnect drain held back rather than touching the team room. */
export interface TrackerDrainHold {
  reason: 'unresolved-policy-would-delete' | 'zero-upserts-with-deletes';
  /** Local rows waiting on the hold. */
  rowsHeldBack: number;
}

/** Serialized shared-view row projected by TrackerPersistence. */
export interface TrackerSavedViewRecord {
  viewId: string;
  payload: string;
}

export interface TrackerDataSnapshot {
  items: TrackerItem[];
  savedViews: TrackerSavedViewRecord[];
  /** Remote members currently connected to this tracker room. */
  presence: TrackerPresenceMember[];
  sync: TrackerSyncState;
}

export interface TrackerPresenceMember {
  teamMemberId: TeamMemberId;
  displayName: string;
  avatarUrl: string | null;
}

export interface TrackerMutationRejection {
  workspacePath: string;
  itemId: string;
  clientMutationId?: string;
  code: TrackerMutationRejectCode;
  message?: string;
}

export type TrackerDataChange =
  | { type: 'items-replaced'; items: TrackerItem[] }
  | { type: 'items-upserted'; items: TrackerItem[] }
  | { type: 'items-removed'; itemIds: string[] }
  | { type: 'saved-views-replaced'; savedViews: TrackerSavedViewRecord[] }
  | { type: 'presence'; members: TrackerPresenceMember[] }
  | { type: 'status'; sync: TrackerSyncState }
  | { type: 'mutation-rejected'; rejection: TrackerMutationRejection }
  | {
      type: 'config-changed';
      workspacePath: string;
      config: { issueKeyPrefix: string };
    };

export interface TrackerCreateItemInput {
  id: string;
  creationRequestId?: string;
  type: string;
  title: string;
  status: string;
  priority: string;
  workspace: string;
  description?: string;
  owner?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
  sharing?: 'personal' | 'team';
  draftByDefault?: boolean;
  content?: unknown;
  source?: string;
  sourceRef?: string;
}

export interface TrackerUpdateItemInput {
  itemId: string;
  updates: Record<string, unknown>;
  sharing?: 'personal' | 'team';
  draftByDefault?: boolean;
}

export interface TrackerBatchUpdateInput {
  entries: Array<{
    itemId: string;
    fileUpdates?: Record<string, unknown>;
    storeUpdates?: Record<string, unknown>;
    sharing?: 'personal' | 'team';
    draftByDefault?: boolean;
  }>;
}

export type TrackerDataCommand =
  | { type: 'list-items' }
  | { type: 'refresh-items' }
  | { type: 'create-item'; item: TrackerCreateItemInput }
  | { type: 'update-item'; input: TrackerUpdateItemInput }
  | { type: 'update-items'; input: TrackerBatchUpdateInput }
  | { type: 'archive-item'; itemId: string; archive: boolean }
  | { type: 'delete-item'; itemId: string }
  | { type: 'update-item-content'; itemId: string; content: unknown }
  | { type: 'add-comment'; itemId: string; body: string }
  | {
      type: 'update-comment';
      itemId: string;
      commentId: string;
      body?: string;
      deleted?: boolean;
    }
  | { type: 'share-saved-view'; savedView: TrackerSavedViewRecord }
  | { type: 'unshare-saved-view'; viewId: string }
  | { type: 'reconnect' };

/**
 * How a caller names the revision it wants (knowledge-scopes contract 4.2).
 *
 * `revisionId` is the UUID assigned wherever the write happened and is the only
 * identity that exists everywhere. `serverRevision` is the room-assigned
 * sequential number, which is what a published citation or a public bundle
 * carries; it is absent for personal and unsynced revisions, so a lookup by it
 * legitimately finds nothing on a host that has never synced the item.
 */
export type TrackerRevisionRef =
  | { revisionId: string }
  | { serverRevision: number };

/**
 * One exact revision of one item's field bag.
 *
 * Mirrors the desktop store's row rather than reshaping it, so the renderer and
 * a future web-console implementation agree on the wire shape.
 */
export interface TrackerItemRevisionRecord {
  revisionId: string;
  itemId: string;
  /** The revision this one superseded; null for an item's first revision. */
  parentRevisionId: string | null;
  /** Null means "never been to the server", not "revision 0". */
  serverRevision: number | null;
  workspace: string;
  /** Full field bag as of this revision, not a delta. */
  data: Record<string, unknown>;
  actor: { id?: string; name?: string } | null;
  /**
   * Null means the stored row alone could not decide, NOT draft: resolving it
   * needs the tracker schema's `draftByDefault`.
   */
  published: boolean | null;
  /** Non-null when this revision is the item's deletion tombstone. */
  deletedAt: number | null;
  recordedAt: number;
}

/**
 * Thrown when a pinned revision does not exist on this host.
 *
 * A distinct type because the one rule this read exists to keep is that **a
 * missing revision is an error, never the latest**. A citation that pins
 * revision 3 and quietly renders revision 7 is worse than one that fails,
 * because nothing in the result says the evidence moved. Callers that catch
 * broadly must not collapse this into "no data".
 */
export class TrackerRevisionUnavailableError extends Error {
  constructor(
    readonly itemId: string,
    readonly ref: TrackerRevisionRef,
    message?: string,
  ) {
    super(message ?? `Tracker item '${itemId}' has no revision ${JSON.stringify(ref)}`);
    this.name = 'TrackerRevisionUnavailableError';
  }
}

/** Thrown by a host that has no revision log at all, as distinct from one that looked and did not find it. */
export class TrackerRevisionsUnsupportedError extends Error {
  constructor(readonly host: string) {
    super(`${host} does not keep a tracker revision log`);
    this.name = 'TrackerRevisionsUnsupportedError';
  }
}

export interface TrackerDataCommandResult extends CollabCommandResult {
  /** The existing host mutation result, preserved without renderer-side reshaping. */
  result?: unknown;
  items?: TrackerItem[];
  savedViews?: TrackerSavedViewRecord[];
}

/**
 * Projection/command seam between tracker UI state and a host-owned sync engine.
 *
 * Desktop proxies the engine through Electron IPC; browsers host it in-page.
 * The lifecycle deliberately matches CollabDataSource without exposing either
 * host's transport.
 */
export interface TrackerDataSource {
  snapshot(): Promise<TrackerDataSnapshot>;
  subscribe(cb: (change: TrackerDataChange) => void): Unsubscribe;
  command(command: TrackerDataCommand): Promise<TrackerDataCommandResult>;
  status(): TrackerSyncState;
  /**
   * Read one exact revision (knowledge-scopes contract 4.2).
   *
   * Deliberately a reader rather than a `TrackerDataCommand`: a command returns
   * `{ ok: false }`, which a caller can ignore into rendering nothing, and
   * "rendered nothing" is indistinguishable from "rendered the item as it is
   * today". This read must either produce the pinned revision or throw
   * `TrackerRevisionUnavailableError`.
   *
   * Hosts with no revision log throw `TrackerRevisionsUnsupportedError`, which
   * is a different answer from "that revision does not exist" and must stay
   * one: the first means the citation is unverifiable here, the second means
   * the evidence is gone.
   */
  getItemRevision(itemId: string, ref: TrackerRevisionRef): Promise<TrackerItemRevisionRecord>;
  dispose(): void;
}

// Compile-time assertion that tracker commands retain the shared command shape.
const _trackerDataCommand: CollabCommand = {} as TrackerDataCommand;
void _trackerDataCommand;
