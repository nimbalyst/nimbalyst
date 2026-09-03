/**
 * TrackerFieldEditor - Reusable field editor for tracker data model fields.
 * Renders the appropriate input control based on FieldDefinition type.
 * Used by both StatusBar (document headers) and TrackerItemDetail (edit panel).
 */
import React from 'react';
import type { FieldDefinition } from '../models/TrackerDataModel';
import { type RelationshipCandidate } from './RelationshipFieldEditor';
/** Team member info for user picker dropdown */
export interface TeamMemberOption {
    /** Stable organization member id, when the roster provider exposes it. */
    memberId?: string;
    email: string;
    name?: string;
}
export interface TrackerFieldEditorProps {
    field: FieldDefinition;
    value: any;
    onChange: (value: any) => void;
    /** 'vertical' = label on top (default), 'horizontal' = label on left */
    layout?: 'horizontal' | 'vertical';
    /** Team members for user picker dropdowns (when available) */
    teamMembers?: TeamMemberOption[];
    /** Candidate target items for relationship-field typeahead (when available). */
    relationshipCandidates?: RelationshipCandidate[];
    /** Open a related tracker item (relationship pill click). */
    onOpenRelationship?: (itemId: string) => void;
    /**
     * Render the field-name label above the control. Surfaces that already name
     * the field (the chip popover header) turn this off to avoid saying it twice.
     */
    showLabel?: boolean;
}
/**
 * Format a datetime value for read-only display.
 * Shows relative date (e.g. "Mar 14, 2026") with full timestamp on hover.
 *
 * Parses through `parseDate` rather than `new Date`: a `date` field holds a
 * calendar day (`YYYY-MM-DD`), and bare `new Date` reads that as UTC midnight,
 * which renders as the previous day anywhere west of Greenwich (nimbalyst#1135).
 */
export declare function formatDateTimeDisplay(value: any): {
    display: string;
    title: string;
};
export declare const TrackerFieldEditor: React.FC<TrackerFieldEditorProps>;
