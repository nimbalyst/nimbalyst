/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {IS_CHROME} from '@lexical/utils';
import {
    $getSiblingCaret,
    $isElementNode,
    $rewindSiblingCaret,
    DOMConversionMap,
    DOMConversionOutput,
    DOMExportOutput,
    EditorConfig,
    ElementNode,
    isHTMLElement,
    LexicalEditor,
    LexicalNode,
    NodeKey,
    RangeSelection,
    SerializedElementNode,
    Spread,
} from 'lexical';

import {setDomHiddenUntilFound} from './CollapsibleUtils';

type SerializedCollapsibleContainerNode = Spread<
    {
        open: boolean;
        classification?: string;
        readOnly?: boolean;
    },
    SerializedElementNode
>;

export function $convertDetailsElement(
    domNode: HTMLDetailsElement,
): DOMConversionOutput | null {
    const isOpen = domNode.open !== undefined ? domNode.open : true;
    const node = $createCollapsibleContainerNode(isOpen);
    return {
        node,
    };
}

export class CollapsibleContainerNode extends ElementNode {
    __open: boolean;
    __classification?: string;
    __readOnly?: boolean;

    constructor(
        open: boolean,
        classification?: string,
        readOnly?: boolean,
        key?: NodeKey
    ) {
        super(key);
        this.__open = open;
        this.__classification = classification;
        this.__readOnly = readOnly;
    }

    static getType(): string {
        return 'collapsible-container';
    }

    static clone(node: CollapsibleContainerNode): CollapsibleContainerNode {
        return new CollapsibleContainerNode(
            node.__open,
            node.__classification,
            node.__readOnly,
            node.__key
        );
    }

    isShadowRoot(): boolean {
        return true;
    }

    collapseAtStart(selection: RangeSelection): boolean {
        // Unwrap the CollapsibleContainerNode by replacing it with the children
        // of its children (CollapsibleTitleNode, CollapsibleContentNode)
        const nodesToInsert: LexicalNode[] = [];
        for (const child of this.getChildren()) {
            if ($isElementNode(child)) {
                nodesToInsert.push(...child.getChildren());
            }
        }
        const caret = $rewindSiblingCaret($getSiblingCaret(this, 'previous'));
        caret.splice(1, nodesToInsert);
        // Merge the first child of the CollapsibleTitleNode with the
        // previous sibling of the CollapsibleContainerNode
        const [firstChild] = nodesToInsert;
        if (firstChild) {
            firstChild.selectStart().deleteCharacter(true);
        }
        return true;
    }

    createDOM(config: EditorConfig, editor: LexicalEditor): HTMLElement {
        // details is not well supported in Chrome #5582
        let dom: HTMLElement;
        if (IS_CHROME) {
            dom = document.createElement('div');
            if (this.__open) {
                dom.setAttribute('open', '');
            }
        } else {
            const detailsDom = document.createElement('details');
            detailsDom.open = this.__open;
            detailsDom.addEventListener('toggle', () => {
                const open = editor.getEditorState().read(() => this.getOpen());
                if (open !== detailsDom.open) {
                    editor.update(() => this.toggleOpen());
                }
            });
            dom = detailsDom;
        }
        dom.classList.add('Collapsible__container');

        // Set contentEditable to false if read-only
        if (this.__readOnly) {
            dom.contentEditable = 'false';
        }

        // Add classification as data attribute
        if (this.__classification) {
            dom.setAttribute('data-collapsible-classification', this.__classification);
        }

        return dom;
    }

    updateDOM(prevNode: this, dom: HTMLDetailsElement): boolean {
        const currentOpen = this.__open;
        if (prevNode.__open !== currentOpen) {
            // details is not well supported in Chrome #5582
            if (IS_CHROME) {
                const contentDom = dom.children[1] as HTMLElement;
                if (!isHTMLElement(contentDom)) {
                    throw new Error('Expected contentDom to be an HTMLElement');
                }
                if (currentOpen) {
                    dom.setAttribute('open', '');
                    contentDom.hidden = false;
                } else {
                    dom.removeAttribute('open');
                    setDomHiddenUntilFound(contentDom);
                }
            } else {
                dom.open = this.__open;
            }
        }

        // Update read-only state if changed
        if (prevNode.__readOnly !== this.__readOnly) {
            if (this.__readOnly) {
                dom.contentEditable = 'false';
            } else {
                dom.contentEditable = 'true';
            }
        }

        // Update classification if changed
        if (prevNode.__classification !== this.__classification) {
            if (this.__classification) {
                dom.setAttribute('data-collapsible-classification', this.__classification);
            } else {
                dom.removeAttribute('data-collapsible-classification');
            }
        }

        return false;
    }

    static importDOM(): DOMConversionMap<HTMLDetailsElement> | null {
        return {
            details: (domNode: HTMLDetailsElement) => {
                return {
                    conversion: $convertDetailsElement,
                    priority: 1,
                };
            },
        };
    }

    static importJSON(
        serializedNode: SerializedCollapsibleContainerNode,
    ): CollapsibleContainerNode {
        return $createCollapsibleContainerNode(
            serializedNode.open,
            serializedNode.classification,
            serializedNode.readOnly
        ).updateFromJSON(serializedNode);
    }

    exportDOM(): DOMExportOutput {
        const element = document.createElement('details');
        element.classList.add('Collapsible__container');
        element.setAttribute('open', this.__open.toString());
        return {element};
    }

    exportJSON(): SerializedCollapsibleContainerNode {
        return {
            ...super.exportJSON(),
            open: this.__open,
            classification: this.__classification,
            readOnly: this.__readOnly,
        };
    }

    setOpen(open: boolean): void {
        const writable = this.getWritable();
        writable.__open = open;
    }

    getOpen(): boolean {
        return this.getLatest().__open;
    }

    toggleOpen(): void {
        this.setOpen(!this.getOpen());
    }

    setClassification(classification?: string): void {
        const writable = this.getWritable();
        writable.__classification = classification;
    }

    getClassification(): string | undefined {
        return this.getLatest().__classification;
    }

    setReadOnly(readOnly?: boolean): void {
        const writable = this.getWritable();
        writable.__readOnly = readOnly;
    }

    getReadOnly(): boolean | undefined {
        return this.getLatest().__readOnly;
    }
}

export function $createCollapsibleContainerNode(
    isOpen: boolean,
    classification?: string,
    readOnly?: boolean
): CollapsibleContainerNode {
    return new CollapsibleContainerNode(isOpen, classification, readOnly);
}

export function $isCollapsibleContainerNode(
    node: LexicalNode | null | undefined,
): node is CollapsibleContainerNode {
    return node instanceof CollapsibleContainerNode;
}
