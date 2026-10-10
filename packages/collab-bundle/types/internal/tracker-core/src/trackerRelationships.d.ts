import type { TrackerFieldDefinition } from "./context.js";
export interface TrackerRelationshipValue {
    itemId: string;
    issueKey?: string;
    title?: string;
    trackerType?: string;
    relationshipTypeKey?: string;
    direction?: "out";
    metadata?: Record<string, unknown>;
    /**
     * Pins the reference to one exact revision of the target (knowledge-scopes
     * contract 4.2). A UUID; absent means the live item. Mirrored from the richer
     * declaration in `@nimbalyst/tracker-schema`, which cannot be imported here.
     */
    revisionId?: string;
    /** Room-assigned display number for `revisionId`. Advisory; never resolves. */
    serverRevision?: number;
}
export declare function isRelationshipField(def: Pick<TrackerFieldDefinition, "type">): boolean;
export declare function normalizeRelationshipValue(raw: unknown): TrackerRelationshipValue[];
