/**
 * The choice list a select or people cell opens, the same list a field chip
 * opens, anchored under the cell being edited, with a filter to type into.
 *
 * Typing on a selected cell starts the edit with that key, so the filter opens
 * holding it: type a name and press Enter. Arrow keys move through the matches
 * while the keys stay in the filter.
 *
 * RevoGrid editors render Stencil vnodes, so the cell editor mounts this in its
 * own React root (`mountTrackerGridChoicePopover`) and tears it down when
 * RevoGrid disconnects the editor. RevoGrid reads keys at the document, so the
 * popover keeps its own keys from reaching the grid.
 */
import React from 'react';
import { type TrackerFieldChoice } from '../../../../runtime/src/plugins/TrackerPlugin/components/TrackerFieldChoiceList';
export interface TrackerGridChoicePopoverProps {
    anchor: Element;
    choices: readonly TrackerFieldChoice[];
    /** The stored value. */
    value: string;
    /** What was typed to start the edit, if anything. */
    initialQuery?: string;
    onPick: (value: string) => void;
    onCancel: () => void;
}
/**
 * Choices whose label or value contains the query, case-insensitively: a word
 * of the label starting with it first, then the label containing it, then only
 * the value (an email) containing it -- "g" should find Greg before gmail.com.
 */
export declare function filterTrackerFieldChoices(choices: readonly TrackerFieldChoice[], query: string): TrackerFieldChoice[];
export declare function TrackerGridChoicePopover({ anchor, choices, value, initialQuery, onPick, onCancel }: TrackerGridChoicePopoverProps): React.JSX.Element;
/** Mounts the popover in its own root; the returned function unmounts it. */
export declare function mountTrackerGridChoicePopover(props: TrackerGridChoicePopoverProps): () => void;
