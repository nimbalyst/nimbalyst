/**
 * EmbeddedFileNode -- a Lexical DecoratorNode that renders another file
 * (e.g. an Excalidraw canvas) inline inside a host markdown document.
 *
 * The node stores a path (`__src`) plus a label and key=value attribute bag
 * derived from the markdown link title. Markdown round-trips as a CommonMark
 * link: `[label](./path/to/file "k=v k=v")`.
 *
 * The actual editor inside the embed is rendered by a host-supplied
 * component registered via `setEmbedPluginCallbacks`. The runtime package
 * does not know how to read files or look up extensions; those concerns live
 * in the renderer-side `EmbedFrame`.
 *
 * React-free: `./EmbeddedFileNode.tsx` registers the React decorator and
 * re-exports this module; headless graphs (collab worker, CLI) import this one
 * directly. See `nodeDecoratorSlot.ts`.
 */
import type { JSX } from 'react';
import { DecoratorNode, type DOMConversionMap, type DOMExportOutput, type EditorConfig, type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical';
export type EmbedAttrs = Record<string, string>;
export declare const PLACED_VIEW_ATTR_KEYS: readonly ["mode", "cols", "sort", "filter", "group", "scope", "w", "ordering", "hide", "start", "end", "x", "y", "xl", "yl", "q", "pin", "height", "width"];
export interface EmbeddedFilePayload {
    src: string;
    label: string;
    attrs?: EmbedAttrs;
    /**
     * The link title exactly as written, for web link previews. When set, it is
     * the source of truth: `attrs` is parsed from it and export writes it back
     * verbatim. File embeds leave it null and keep the attribute-map export.
     */
    title?: string | null;
    key?: NodeKey;
}
export type SerializedEmbeddedFileNode = Spread<{
    src: string;
    label: string;
    attrs: EmbedAttrs;
    title?: string;
}, SerializedLexicalNode>;
export declare const EmbeddedFileNodeDecorator: import("../../nodes/nodeDecoratorSlot").NodeDecoratorSlot<EmbeddedFileNode>;
export declare class EmbeddedFileNode extends DecoratorNode<JSX.Element | null> {
    __src: string;
    __label: string;
    __attrs: EmbedAttrs;
    __title: string | null;
    [key: `__view_${string}`]: string | null;
    constructor(src: string, label: string, attrs: EmbedAttrs, key?: NodeKey, title?: string | null);
    static getType(): string;
    static clone(node: EmbeddedFileNode): EmbeddedFileNode;
    static importJSON(serializedNode: SerializedEmbeddedFileNode): EmbeddedFileNode;
    exportJSON(): SerializedEmbeddedFileNode;
    createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement;
    updateDOM(prev: EmbeddedFileNode): boolean;
    exportDOM(): DOMExportOutput;
    static importDOM(): DOMConversionMap | null;
    /**
     * Override so the diff system and copy-as-text paths still produce
     * something meaningful when an embed is part of a comparison.
     */
    getTextContent(): string;
    getSrc(): string;
    getLabel(): string;
    /** The verbatim link title, or null for embeds whose title is the attribute map. */
    getTitle(): string | null;
    /** Replace the verbatim title; the attribute map follows it. */
    setTitle(title: string): void;
    getAttrs(): EmbedAttrs;
    setSrc(src: string): void;
    setLabel(label: string): void;
    setAttrs(attrs: EmbedAttrs): void;
    /** Merge one settings gesture into the current node, preserving other keys. */
    patchViewAttrs(patch: Readonly<Record<string, string | null>>): void;
    decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null;
}
export declare function $createEmbeddedFileNode(payload: EmbeddedFilePayload): EmbeddedFileNode;
export declare function $isEmbeddedFileNode(node: LexicalNode | null | undefined): node is EmbeddedFileNode;
