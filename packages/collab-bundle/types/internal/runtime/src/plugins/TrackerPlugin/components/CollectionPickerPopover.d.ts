/**
 * CollectionPickerPopover — the editor behind a "Collection" chip.
 *
 * Collection membership is an ordinary multi-value relationship field pointing
 * at milestone/release items, but the generic relationship editor (a native
 * datalist typeahead) makes the common case — "put this in the current sprint,
 * or start a new one" — a multi-step guess. This picker searches the existing
 * collections, toggles membership in place, and can create-and-assign a new
 * collection from whatever the user typed.
 *
 * Presentation only: all value math delegates to the pure relationship model,
 * and creation is a caller-supplied callback because item creation lives on the
 * Electron side. The caller persists whatever `onChange` hands back, which keeps
 * both sides of the link consistent via the normal inverse-propagation path.
 */
import React from 'react';
import type { FieldDefinition, TrackerRelationshipValue } from '../../../../../tracker-schema/src/browser';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
import './CollectionPickerPopover.css';
export interface CollectionPickerPopoverProps {
    /** The member-side collection field being edited. */
    field: FieldDefinition;
    /** Current field value (single object or array, per `field.multiValue`). */
    value: unknown;
    /** Collection items this field may point at. */
    candidates?: RelationshipCandidate[];
    /** Persist the next field value. */
    onChange: (value: TrackerRelationshipValue | TrackerRelationshipValue[] | null) => void;
    /**
     * Create a collection of `type` titled `title` and resolve to it. Omit to hide
     * the inline create affordance (e.g. surfaces with no creation path).
     */
    onCreateCollection?: (title: string, type: string) => Promise<RelationshipCandidate | null>;
    /** Open a collection from its assigned chip. */
    onOpenItem?: (itemId: string) => void;
    /** Close the surrounding popover (Escape, or a completed single-value pick). */
    onRequestClose?: () => void;
    /** Test id prefix; defaults to `collection-picker`. */
    testIdBase?: string;
}
export declare const CollectionPickerPopover: React.FC<CollectionPickerPopoverProps>;
