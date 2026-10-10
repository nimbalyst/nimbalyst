/**
 * Multi-select picker for a `label-ref` field (an item's labels).
 *
 * Labels come from the project's label registry and are shown as a tree: each
 * label sits under its first declared broader label, indented. A label the
 * item carries that the registry does not declare (a pending proposal, or a
 * typo from an agent) is listed first and flagged -- never dropped, because
 * dropping it on the next save would silently delete data.
 *
 * Renders inline; the chip popover that hosts it already owns positioning.
 * Loaded lazily by `TrackerFieldEditor`; reading a stored value is
 * `labelRefValue.ts`.
 */
import React from 'react';
import { type LabelRegistry } from '../../../../../tracker-schema/src/browser';
export interface LabelPickerRow {
    id: string;
    label: string;
    depth: number;
    /** False for a label the registry does not declare. */
    known: boolean;
    selected: boolean;
    description?: string;
    icon?: string;
    color?: string;
}
/**
 * Picker rows: unknown selected labels first, then the registry as a tree in
 * declaration order. A label with several broader labels appears once, under
 * the first one the registry declares.
 */
export declare function labelPickerRows(registry: LabelRegistry, selectedIds: readonly string[]): LabelPickerRow[];
export interface LabelRefPickerProps {
    value: unknown;
    onChange: (next: string[]) => void;
    readOnly?: boolean;
    /** Defaults to the active registry. */
    registry?: LabelRegistry;
}
export declare const LabelRefPicker: React.FC<LabelRefPickerProps>;
