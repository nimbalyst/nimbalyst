/**
 * Canonical tracker record -- the single authoritative shape for tracker items.
 *
 * All user-defined business data lives in `fields`.
 * System/infrastructure metadata lives in `system`.
 * No layer outside the schema may assume field names.
 */
import type { LegacyTrackerItem as TrackerItem, TrackerActivity, TrackerComment, TrackerIdentity, TrackerOrigin } from './types.js';
import { type TrackerDerivedSignal } from './planStatusIntegrity.js';
export type { TrackerDerivedSignal } from './planStatusIntegrity.js';
export { fromDbBoolean } from './dbBoolean.js';
export interface LinkedCommit {
    sha: string;
    message: string;
    sessionId?: string;
    timestamp: string;
}
/**
 * Explicit link from a tracker item to a pull request, written by the PR
 * view's "Link tracker item" action (or agent tooling). Complements the
 * zero-config path where any url-type field matching a PR URL counts as a
 * reference (see plugins/TrackerPlugin/prReferences.ts).
 */
export interface LinkedPullRequest {
    /** GitHub remote as "owner/repo" (lowercase). */
    remote: string;
    number: number;
    url?: string;
}
/**
 * Explicit link from a tracker item to a GitHub issue, written by the issue
 * view's "Link tracker item" action (or agent tooling). Complements the
 * zero-config path where any url-type field matching an issue URL counts as a
 * reference (see plugins/TrackerPlugin/issueReferences.ts).
 */
export interface LinkedIssue {
    /** GitHub remote as "owner/repo" (lowercase). */
    remote: string;
    number: number;
    url?: string;
}
export interface TrackerRecordSystem {
    workspace: string;
    documentPath?: string;
    lineNumber?: number;
    createdAt: string;
    updatedAt: string;
    lastIndexed?: string;
    authorIdentity?: TrackerIdentity | null;
    lastModifiedBy?: TrackerIdentity | null;
    createdByAgent?: boolean;
    linkedSessions?: string[];
    linkedCommitSha?: string;
    linkedCommits?: LinkedCommit[];
    /** Read-only signals derived from fields and linked evidence; never persisted. */
    derivedSignals?: TrackerDerivedSignal[];
    linkedPullRequests?: LinkedPullRequest[];
    linkedIssues?: LinkedIssue[];
    documentId?: string;
    activity?: TrackerActivity[];
    comments?: TrackerComment[];
    /** Structured origin (how the item entered Nimbalyst; pointer to upstream for imports). */
    origin?: TrackerOrigin;
    /**
     * When a person decided this item is correctly where it is and retired it from
     * the triage inbox without changing it. Shared rather than personal (unlike
     * snooze): triage is a decision the team makes once, so a colleague's pass
     * clears the item for everyone.
     */
    triagedAt?: string;
    triagedBy?: TrackerIdentity | null;
}
export interface TrackerRecord {
    id: string;
    primaryType: string;
    typeTags: string[];
    issueNumber?: number;
    issueKey?: string;
    /**
     * This machine's private number for the item (`NIM.12`). Never synced: a
     * teammate's copy of the same item has none, and the same value on another
     * machine means a different item. Separate from `issueKey` because the room
     * owns that field and rejects an item that arrives already carrying a key.
     */
    localKey?: string;
    /**
     * `local-wiki`: a typed page or table row of a Local wiki folder, read
     * through `@nimbalyst/local-wiki` in the renderer. It exists only in the
     * renderer's tracker map and must never be written to a database, synced or
     * shared; its edits go to the library.
     */
    source: 'native' | 'inline' | 'frontmatter' | 'import' | 'local-wiki';
    sourceRef?: string;
    /**
     * Identity of this item's newest entry in the append-only revision history
     * (knowledge-scopes contract 4.2). A UUID, not a counter: a locally assigned
     * sequence would name a different write on each machine, the same reason
     * issue keys are minted by the room rather than locally.
     *
     * Optional and absent by default: `tracker_items` has no revision column, so
     * only a reader that joins `tracker_item_revisions` populates it. A citation
     * pinning a revision resolves it through that table, never through a live
     * record that happens to carry this field.
     */
    revisionId?: string;
    /**
     * Sequential revision number assigned by the room on sync. Absent for
     * personal items and for anything that has not synced; never assigned
     * locally.
     */
    serverRevision?: number;
    archived: boolean;
    syncStatus: 'local' | 'pending' | 'synced';
    content?: unknown;
    system: TrackerRecordSystem;
    fields: Record<string, unknown>;
}
/**
 * Convert a legacy TrackerItem to the canonical TrackerRecord.
 * All TrackerItem properties that aren't system/routing keys go into `fields`.
 * No privileged field vocabulary -- the converter is generic.
 */
export declare function trackerItemToRecord(item: TrackerItem): TrackerRecord;
/**
 * Convert a canonical TrackerRecord back to the legacy TrackerItem shape.
 * Used during the migration period while consumers still expect TrackerItem.
 *
 * Maps record.fields back to TrackerItem's top-level properties.
 * All fields that don't map to a TrackerItem property go into customFields.
 */
export declare function trackerRecordToItem(record: TrackerRecord): TrackerItem;
/**
 * Convert a PGLite tracker_items row to a TrackerRecord.
 *
 * The row has top-level SQL columns (id, type, workspace, etc.)
 * plus a JSONB `data` column that contains all field values and
 * system metadata mixed together.
 */
export declare function dbRowToRecord(row: any): TrackerRecord;
/**
 * Prepare parameters for inserting/updating a TrackerRecord in PGLite.
 *
 * Returns the JSONB `data` payload (merging fields + system metadata)
 * and the top-level column values needed for the SQL statement.
 */
export declare function recordToDbParams(record: TrackerRecord): {
    id: string;
    type: string;
    typeTags: string[];
    data: string;
    workspace: string;
    documentPath: string;
    lineNumber: number | null;
    syncStatus: string;
    content: string | null;
    archived: boolean;
    source: string;
    sourceRef: string | null;
};
