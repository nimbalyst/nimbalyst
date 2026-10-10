import type { NodeKey } from 'lexical';
import type { ComponentType, RefObject } from 'react';
import type { TrackerReferenceView } from './TrackerReferenceNodeCore';
export interface TrackerReferenceNodeRendererProps {
    referenceKey: string;
    nodeKey: NodeKey;
    view: TrackerReferenceView;
    /** Predicate id of the relation this link states; null for a plain link. */
    relation?: string | null;
    /** The link as written (`nimbalyst://KEY` or a console link), for a host that treats some scopes apart. */
    href?: string | null;
}
export declare function setTrackerReferenceNodeRenderer(renderer: ComponentType<TrackerReferenceNodeRendererProps> | undefined): void;
export declare function getTrackerReferenceNodeRenderer(): ComponentType<TrackerReferenceNodeRendererProps> | undefined;
/**
 * Returns focus to the enclosing editor with its previous selection, for a
 * control inside a reference that briefly took focus (a menu's text field).
 * Null outside a Lexical editor.
 */
export declare function useTrackerReferenceEditorFocus(): (() => void) | null;
/**
 * Whether the reference node is node-selected (by arrowing onto it, or by a
 * click inside `elementRef` that is not on a link/button or a text drag), so a
 * renderer can show a selected cue. False outside a Lexical editor, which lets
 * the same renderer serve read-only host surfaces.
 */
export declare function useTrackerReferenceNodeSelected(nodeKey: NodeKey, elementRef?: RefObject<HTMLElement | null>): boolean;
