/**
 * The one row under a page's title that says what the page is: the type chip,
 * then the fields that hold a value, then a faint "+" listing the empty ones.
 * A typed page in Pages and a typed markdown file in Files draw this same row,
 * so a page reads the same wherever it lives.
 *
 * Values arrive as stored (label fields still wrapped) and leave the same way:
 * `onSaveField` gets the stored shape, ready to write.
 */
import React from 'react';
import type { FieldDefinition } from '../../../../../tracker-schema/src/browser';
import type { TeamMemberOption } from './TrackerFieldEditor';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import './TrackerTypeRow.css';
export interface TrackerAddFieldMenuProps {
    /** Empty fields the row can still show, in schema order. */
    fields: readonly FieldDefinition[];
    onAdd: (fieldName: string) => void;
    testIdBase?: string;
}
/** The faint "+" at the end of the row: the empty fields, one click to add. */
export declare const TrackerAddFieldMenu: React.FC<TrackerAddFieldMenuProps>;
export interface TrackerTypeRowProps {
    typeId: string;
    /** Stored values, label fields still wrapped. */
    values: Record<string, unknown>;
    editable: boolean;
    onSaveField: (field: FieldDefinition, storedValue: unknown) => void;
    /**
     * `page` (Pages): single-valued fields only; relations live in Links.
     * `all` (Files): every chip field, since a file has no Links section.
     */
    fieldSet?: 'page' | 'all';
    /** The chip's color; the type's own color by default. */
    typeColor?: string;
    /**
     * The row's fields when they don't come from a registered type: a plain
     * page's own fields (owner, status, summary). Used as given, in order.
     */
    fields?: readonly FieldDefinition[];
    /** Replaces the type chip (a plain page's "Page", which opens Set type). */
    typeChip?: React.ReactNode;
    /** Changing it forgets fields added from the "+" (a different page). */
    resetKey?: string;
    /** Right-aligned at the end of the row (updated, key). */
    end?: React.ReactNode;
    teamMembers?: TeamMemberOption[];
    relationshipCandidates?: Map<string, RelationshipCandidate[]>;
    onOpenItem?: (itemId: string) => void;
    onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
    testIdBase?: string;
    className?: string;
}
export declare const TrackerTypeRow: React.FC<TrackerTypeRowProps>;
