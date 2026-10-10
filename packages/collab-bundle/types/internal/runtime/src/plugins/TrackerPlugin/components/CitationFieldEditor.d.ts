/**
 * The `citation` field type's editor: a chip per attached citation, each one
 * opening {@link CitationInspector}.
 *
 * The chip list and the add typeahead deliberately mirror
 * `RelationshipFieldEditor` -- a citation entry is a reference to an item, and
 * a second visual idiom for "a list of linked items" would be a second thing to
 * keep consistent for no gain. What is different is what sits behind the chip:
 * a relationship pill navigates, a citation chip opens the evidence.
 *
 * Adding a citation here attaches an EXISTING `citation` item. Authoring one
 * (source, capture, locator, excerpt) is the knowledge extension's job (N13);
 * this field is the attach point, not a capture form.
 */
import React from 'react';
import type { CitationFieldValue, FieldDefinition } from '../../../../../tracker-schema/src/browser';
import { type CitationInspectorHost } from './CitationInspector';
import type { RelationshipCandidate } from './RelationshipFieldEditor';
export interface CitationFieldEditorProps {
    field: FieldDefinition;
    value: unknown;
    onChange: (value: CitationFieldValue[]) => void;
    host: CitationInspectorHost;
    /** Existing `citation` items the add control offers. */
    candidates?: RelationshipCandidate[];
    /** Open the citation item itself. */
    onOpenItem?: (itemId: string) => void;
    readOnly?: boolean;
}
/**
 * Tolerant read of the stored value. A `citation` field is multi-valued by
 * definition, but a single object is what a hand-written YAML seed or an older
 * MCP write can leave behind, and dropping it would lose evidence rather than
 * surface it.
 */
export declare function readCitationEntries(value: unknown): CitationFieldValue[];
export declare const CitationFieldEditor: React.FC<CitationFieldEditorProps>;
