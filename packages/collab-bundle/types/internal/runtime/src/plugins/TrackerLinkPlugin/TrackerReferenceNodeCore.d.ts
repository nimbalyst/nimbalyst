/**
 * TrackerReferenceNode — an inline reference (pointer) to a tracker item.
 *
 * Unlike `TrackerItemNode` (which embeds a frozen snapshot of an item inline),
 * this node stores ONLY the reference key (e.g. `NIM-123`). The decorated chip
 * resolves the item's title/status *live* at render time via the injected
 * {@link TrackerReferenceResolver}, so editing or closing the item elsewhere
 * updates every chip pointing at it with no document edit.
 *
 * Serializes to a portable markdown link via {@link TrackerReferenceTransformer}:
 * a console link (`https://console.nimbalyst.com/.../page/item/NIM-123`) for
 * references created once the host registered one, `nimbalyst://NIM-123` for
 * older ones, which keep the form they were written in.
 *
 * React-free: `./TrackerReferenceNode.tsx` registers the React decorator and
 * re-exports this module; headless graphs (collab worker, CLI) import this one
 * directly. See `nodeDecoratorSlot.ts`.
 */
import type { DOMConversionMap, DOMExportOutput, EditorConfig, LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import type { JSX } from 'react';
import { DecoratorNode } from 'lexical';
export declare const TRACKER_REFERENCE_URN_SCHEME = "nimbalyst://";
export type TrackerReferenceView = 'chip' | 'card' | 'statements';
export declare function normalizeTrackerReferenceView(view: unknown): TrackerReferenceView;
/** A relation is a predicate id; anything else (empty, non-string) is a plain link. */
export declare function normalizeTrackerReferenceRelation(relation: unknown): string | null;
export type SerializedTrackerReferenceNode = Spread<{
    /** Reference key: an issue key (NIM-123) or local short id (tk_abc123). */
    referenceKey: string;
    view?: TrackerReferenceView;
    /** Predicate id of the named relation this link states; absent = plain link. */
    relation?: string | null;
    /**
     * The link as written, when it is not `nimbalyst://<referenceKey>`: a
     * console link. Kept so the body round-trips byte for byte.
     */
    href?: string | null;
    /**
     * The link text as written, when it is not the reference key: an agent or
     * person wrote `[the sync engine](...)`. The chip still shows the item;
     * the label is kept so the sentence round-trips byte for byte.
     */
    label?: string | null;
}, SerializedLexicalNode>;
export declare const TrackerReferenceNodeDecorator: import("../../editor/nodes/nodeDecoratorSlot").NodeDecoratorSlot<TrackerReferenceNode>;
export declare class TrackerReferenceNode extends DecoratorNode<JSX.Element | null> {
    __referenceKey: string;
    __view: TrackerReferenceView;
    __relation: string | null;
    __href: string | null;
    __label: string | null;
    static getType(): string;
    static clone(node: TrackerReferenceNode): TrackerReferenceNode;
    static importJSON(serializedNode: SerializedTrackerReferenceNode): TrackerReferenceNode;
    constructor(referenceKey: string, key?: NodeKey, view?: TrackerReferenceView, relation?: string | null, href?: string | null, label?: string | null);
    exportJSON(): SerializedTrackerReferenceNode;
    createDOM(config: EditorConfig): HTMLElement;
    updateDOM(prev: TrackerReferenceNode): boolean;
    exportDOM(): DOMExportOutput;
    static importDOM(): DOMConversionMap | null;
    decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null;
    isInline(): true;
    /** Plain-text fallback (copy, non-rich serialization) is the bare key. */
    getTextContent(): string;
    getReferenceKey(): string;
    getView(): TrackerReferenceView;
    setView(view: TrackerReferenceView): this;
    getRelation(): string | null;
    /** The link as written, or null for the `nimbalyst://<referenceKey>` form. */
    getHref(): string | null;
    /** The link text as written, or null when it was the reference key. */
    getLabel(): string | null;
    setRelation(relation: string | null): this;
}
/**
 * `href` is the link as read from markdown or JSON (null for the
 * `nimbalyst://KEY` form). Leave it undefined for a reference created now: it
 * then gets the host's link for the key (see `setTrackerReferenceHrefBuilder`),
 * fixed at creation so every later export, headless ones included, writes the
 * same link. `label` is the link text as read, null when it was the key.
 */
export declare function $createTrackerReferenceNode(referenceKey: string, view?: TrackerReferenceView, relation?: string | null, href?: string | null, label?: string | null): TrackerReferenceNode;
export declare function $isTrackerReferenceNode(node: LexicalNode | null | undefined): node is TrackerReferenceNode;
