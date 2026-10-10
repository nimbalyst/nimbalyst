/**
 * RelationshipFieldEditor — editor/renderer for `relationship` (and legacy
 * `reference`) tracker fields (Epic C Phase 1).
 *
 * Renders the current value as clickable pills with a remove affordance, plus an
 * add control (a native <datalist> typeahead over `candidates` — no manual
 * positioning needed). All value math delegates to the pure, unit-tested model
 * in ../models/trackerRelationships, so this component stays a thin view.
 */
import React from 'react';
import type { FieldDefinition, TrackerRelationshipValue } from '../../../../../tracker-schema/src/browser';
/** A selectable target item for the typeahead. */
export interface RelationshipCandidate {
    itemId: string;
    title?: string;
    issueKey?: string;
    trackerType?: string;
}
export interface RelationshipFieldEditorProps {
    field: FieldDefinition;
    value: unknown;
    onChange: (value: TrackerRelationshipValue | TrackerRelationshipValue[] | null) => void;
    /** Candidate target items for the add typeahead. */
    candidates?: RelationshipCandidate[];
    /** Click a pill to open the related item. */
    onOpenItem?: (itemId: string) => void;
    /** Read-only render (pills only, no add/remove). */
    readOnly?: boolean;
}
export declare const RelationshipFieldEditor: React.FC<RelationshipFieldEditorProps>;
