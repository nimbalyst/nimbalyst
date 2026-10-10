/**
 * Compact tracker metadata chips — the canonical presentation for a tracker
 * item's fields.
 *
 * A chip is its own editor trigger. Select and people chips open their choices
 * directly; fields that need a form surface (tags, dates, text, relationships)
 * reuse TrackerFieldEditor inside the same floating popover. Either way the
 * popover is headed by the name of the field being edited, so a chip that shows
 * only a value never opens an unlabeled editor.
 *
 * This component is presentation only: callers own the item, decide which
 * fields to show (see `useTrackerFieldLayout`), and supply `onSave`.
 */
import React from 'react';
import type { FieldDefinition } from '../../../../../tracker-schema/src/browser';
import { type TeamMemberOption } from './TrackerFieldEditor';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import type { CitationInspectorHost } from './CitationInspector';
import './TrackerFieldPills.css';
export interface TrackerFieldPillsProps {
    /** Label otherwise anonymous values; preserve compact document headers by default. */
    labelFields?: boolean;
    /** Fields to render, already ordered — see `useTrackerFieldLayout`. */
    fields: FieldDefinition[];
    /** Current field values, keyed by field name. */
    values: Record<string, unknown>;
    /** When false every chip renders read-only. Defaults to true. */
    editable?: boolean;
    /** Team members for people chips; when non-empty they pick from a list. */
    teamMembers?: TeamMemberOption[];
    /** Relationship targets, keyed by field name. */
    relationshipCandidates?: Map<string, RelationshipCandidate[]>;
    /** Item lookup and exact-revision read for `citation` chips. */
    citationHost?: CitationInspectorHost;
    /** Persist one field. Called with the field name and its next value. */
    onSave: (fieldName: string, value: unknown) => void | Promise<void>;
    /** Open a related tracker item (relationship chip click-through). */
    onOpenItem?: (itemId: string) => void;
    /**
     * Create a collection of `type` titled `title` and resolve to it. Enables the
     * collection chip's inline "Create …" row; omit and the picker only assigns
     * existing collections.
     */
    onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
    /**
     * Fields whose value was carried over rather than chosen for this item —
     * they render with a distinct treatment. The quick-create popup's rapid-fire
     * loop reuses the previous item's priority/assignee/milestone, and a run that
     * silently inherits `critical` from the first item is the failure this marking
     * exists to prevent.
     */
    carriedFieldNames?: ReadonlySet<string>;
    /** Extra class on the chip row for surface-specific layout. */
    className?: string;
    /**
     * Prefix for emitted test ids: `${testIdBase}-pills`, `${testIdBase}-pill-<field>`,
     * `${testIdBase}-popover-<field>`, `${testIdBase}-choices-<field>`.
     */
    testIdBase?: string;
}
export interface TrackerFieldPillProps {
    labelFields?: boolean;
    field: FieldDefinition;
    value: unknown;
    editable: boolean;
    teamMembers?: TeamMemberOption[];
    relationshipCandidates?: RelationshipCandidate[];
    citationHost?: CitationInspectorHost;
    onOpenItem?: (itemId: string) => void;
    onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
    onSave: (fieldName: string, value: unknown) => void | Promise<void>;
    /** See `TrackerFieldPillsProps.carriedFieldNames`. */
    carried?: boolean;
    testIdBase?: string;
}
/** Header naming the field an open popover edits. */
export declare const TrackerFieldPopoverHeader: React.FC<{
    label: string;
    testId?: string;
}>;
export declare const TrackerFieldPill: React.FC<TrackerFieldPillProps>;
export declare const TrackerFieldPills: React.FC<TrackerFieldPillsProps>;
