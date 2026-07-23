import type {Spread} from "lexical";

import {
    type DOMConversionMap,
    type DOMConversionOutput,
    type DOMExportOutput,
    type EditorConfig,
    type LexicalNode,
    type NodeKey,
    type SerializedTextNode,
    $applyNodeReplacement,
    $createTextNode,
    TextNode,
} from "lexical";
import {$createLinkNode} from "@lexical/link";

import {TextMatchTransformer} from "@lexical/markdown";
import {isEmbeddableUrl} from "../../editor/plugins/EmbedPlugin/embeddableExtensions";
import {parseEmbedAttrs} from "../../editor/plugins/EmbedPlugin/embedAttrs";
import {
    buildImportedDocumentReference,
    exportDocumentLinkHref,
    normalizeDocumentLinkHref,
    parseCollabReferenceDocumentId,
    isCollabReferenceHref,
} from "./documentLinkPaths";

/**
 * Class list for a reference chip. Shared/collaborative references (whose path
 * is a collab-scheme target) get a `--shared` modifier so CSS can give them a
 * distinct tint + icon from local file references.
 */
export function documentReferenceClassName(path: string): string {
    return isCollabReferenceHref(path)
        ? 'document-reference document-reference--shared'
        : 'document-reference';
}

export type SerializedDocumentReferenceNode = Spread<
    {
        documentId: string;
        name: string;
        path: string;
        workspace?: string;
    },
    SerializedTextNode
>;

function convertDocumentReferenceElement(
    domNode: HTMLElement,
): DOMConversionOutput | null {
    const textContent = domNode.textContent;

    if (textContent !== null) {
        const documentId = domNode.getAttribute('data-document-id') || '';
        const name = domNode.getAttribute('data-name') || '';
        const path = domNode.getAttribute('data-path') || '';
        const workspace = domNode.getAttribute('data-workspace') || undefined;
        const node = $createDocumentReferenceNode(documentId, name, path, workspace);
        return {
            node,
        };
    }

    return null;
}

export class DocumentReferenceNode extends TextNode {
    __documentId: string;
    __name: string;
    __path: string;
    __workspace?: string;

    static getType(): string {
        return 'document-reference';
    }

    static clone(node: DocumentReferenceNode): DocumentReferenceNode {
        return new DocumentReferenceNode(node.__documentId, node.__name, node.__path, node.__workspace, node.__text, node.__key);
    }

    static importJSON(serializedNode: SerializedDocumentReferenceNode): DocumentReferenceNode {
        const node = $createDocumentReferenceNode(
            serializedNode.documentId,
            serializedNode.name,
            serializedNode.path,
            serializedNode.workspace
        );
        node.setTextContent(serializedNode.text);
        node.setFormat(serializedNode.format);
        node.setDetail(serializedNode.detail);
        node.setMode(serializedNode.mode);
        node.setStyle(serializedNode.style);
        return node;
    }

    constructor(documentId: string, name: string, path: string, workspace?: string, text?: string, key?: NodeKey) {
        super(text ?? name, key);
        this.__documentId = documentId;
        this.__name = name;
        this.__path = path;
        this.__workspace = workspace;
    }

    exportJSON(): SerializedDocumentReferenceNode {
        return {
            ...super.exportJSON(),
            documentId: this.__documentId,
            name: this.__name,
            path: this.__path,
            workspace: this.__workspace,
            type: 'document-reference',
            version: 1,
        };
    }

    createDOM(config: EditorConfig): HTMLElement {
        const dom = super.createDOM(config);
        dom.spellcheck = false;
        dom.className = documentReferenceClassName(this.__path);
        dom.setAttribute('data-document-id', this.__documentId);
        dom.setAttribute('data-name', this.__name);
        dom.setAttribute('data-path', this.__path);
        if (this.__workspace) {
            dom.setAttribute('data-workspace', this.__workspace);
        } else {
            dom.removeAttribute('data-workspace');
        }
        return dom;
    }

    exportDOM(): DOMExportOutput {
        const element = document.createElement('span');
        element.className = documentReferenceClassName(this.__path); // used for styling saved dom in prompt menu
        element.setAttribute('data-lexical-document-reference', 'true');
        element.setAttribute('data-document-id', this.__documentId);
        element.setAttribute('data-name', this.__name);
        element.setAttribute('data-path', this.__path);
        if (this.__workspace) {
            element.setAttribute('data-workspace', this.__workspace);
        }
        element.textContent = this.__text;
        return {element};
    }

    static importDOM(): DOMConversionMap | null {
        return {
            span: (domNode: HTMLElement) => {
                if (!domNode.hasAttribute('data-lexical-document-reference')) {
                    return null;
                }
                return {
                    conversion: convertDocumentReferenceElement,
                    priority: 1,
                };
            },
        };
    }

    isTextEntity(): true {
        return true;
    }

    canInsertTextBefore(): boolean {
        return false;
    }

    canInsertTextAfter(): boolean {
        return false;
    }

    getDocumentId(): string {
        return this.__documentId;
    }

    getName(): string {
        return this.__name;
    }

    getPath(): string {
        return this.__path;
    }

    getWorkspace(): string | undefined {
        return this.__workspace;
    }
}

export function $createDocumentReferenceNode(documentId: string, name: string, path: string, workspace?: string): DocumentReferenceNode {
    const documentReferenceNode = new DocumentReferenceNode(documentId, name, path, workspace);
    documentReferenceNode.setMode('segmented').toggleDirectionless();
    return $applyNodeReplacement(documentReferenceNode);
}

export function $isDocumentReferenceNode(
    node: LexicalNode | null | undefined,
): node is DocumentReferenceNode {
    return node instanceof DocumentReferenceNode;
}

/**
 * Main transformer for document references.
 * Exports as standard markdown links: [filename](./path/to/file)
 * Imports local relative paths as document references.
 *
 * The regex only matches paths that:
 * - Don't contain :// (excludes http://, https://, etc.)
 * - Don't start with special schemes (mailto:, tel:, #, etc.)
 * - End with a file extension (.md, .txt, .tsx, etc.)
 */
export const DocumentReferenceTransformer: TextMatchTransformer = {
    dependencies: [DocumentReferenceNode],
    export: (node) => {
        if (!$isDocumentReferenceNode(node)) {
            return null;
        }
        const { __name, __path } = node;
        return `[${__name}](${exportDocumentLinkHref(__path)})`;
    },
    // Match markdown links with local file paths only:
    // - Path must end with a file extension (.\w+)
    // - Path must not contain :// (excludes URLs)
    // - Path must not start with # (excludes anchors)
    // - Must not match images or linked images (like [![alt](img)](link))
    // The (?<!!) lookbehind ensures [ is not preceded by ! (excludes inner image links)
    // The (?!!\[) lookahead ensures [ is not followed by ![ (excludes outer linked image wrapper)
    // The (?![^)]*://) ensures no :// anywhere in the path
    importRegExp: /(?<!!)\[(?!!\[)([^\]]+)\]\((?!#)(?![^)]*:\/\/)([^)]+\.\w+)\)/,
    regExp: /(?<!!)\[(?!!\[)([^\]]+)\]\((?!#)(?![^)]*:\/\/)([^)]+\.\w+)\)$/,
    replace: (textNode, match) => {
        const [, name, path] = match;
        const normalizedHref = normalizeDocumentLinkHref(path);

        // Hand-off to the embed pipeline for links to file types an
        // extension has registered as embeddable (e.g. `.excalidraw`,
        // `.csv`). We create a normal LinkNode here instead of a
        // DocumentReferenceNode -- the EmbedExtension's LinkNode transform
        // then upgrades paragraph-isolated embeddable links into block-
        // level EmbeddedFileNodes. Doing it this way means we don't try
        // to embed inside a TextMatchTransformer (which can only produce
        // inline nodes) and the existing `embed=false` opt-out keeps
        // working.
        if (isEmbeddableUrl(normalizedHref)) {
            const linkNode = $createLinkNode(normalizedHref);
            const linkTextNode = $createTextNode(name);
            linkTextNode.setFormat(textNode.getFormat());
            linkNode.append(linkTextNode);
            textNode.replace(linkNode);
            return linkTextNode;
        }

        const importedReference = buildImportedDocumentReference(name, normalizedHref);
        const documentReferenceNode = $createDocumentReferenceNode(
            importedReference.documentId,
            importedReference.name,
            importedReference.path,
            undefined
        );
        textNode.replace(documentReferenceNode);
        return documentReferenceNode;
    },
    trigger: ')',
    type: 'text-match',
};

/**
 * Transformer for collaborative-document references.
 *
 * Inside a collab document, an `@` reference targets a shared document rather
 * than a local file. Its markdown link uses a collab scheme
 * (`nimbalyst://doc/{id}?orgId={org}` deep link, or the internal
 * `collab://org:{org}:doc:{id}` URI) instead of a file path.
 *
 * Export is handled by {@link DocumentReferenceTransformer} — a collab
 * reference is still a `DocumentReferenceNode` whose `__path` already holds the
 * collab target, so the shared export produces `[Title](nimbalyst://doc/...)`.
 * This transformer is import-only: the main transformer's regex deliberately
 * excludes `://` targets, so collab links need their own import path.
 */
export const CollabDocumentReferenceTransformer: TextMatchTransformer = {
    dependencies: [DocumentReferenceNode],
    export: () => null, // Export flows through DocumentReferenceTransformer.
    // Match markdown links whose target is a collab scheme. Excludes images
    // ((?<!!) / (?!!\[)) the same way the main transformer does.
    importRegExp: /(?<!!)\[(?!!\[)([^\]]+)\]\((nimbalyst:\/\/doc\/[^\s)]+|collab:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)/,
    regExp: /(?<!!)\[(?!!\[)([^\]]+)\]\((nimbalyst:\/\/doc\/[^\s)]+|collab:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)$/,
    replace: (textNode, match) => {
        const [, name, target, title] = match;
        const attrs = parseEmbedAttrs(title);
        if (isEmbeddableUrl(target, attrs.embedType)) {
            const linkNode = $createLinkNode(target, title ? {title} : undefined);
            const linkTextNode = $createTextNode(name);
            linkTextNode.setFormat(textNode.getFormat());
            linkNode.append(linkTextNode);
            textNode.replace(linkNode);
            return linkTextNode;
        }
        const documentId = parseCollabReferenceDocumentId(target) ?? '';
        const documentReferenceNode = $createDocumentReferenceNode(
            documentId,
            name,
            target,
            undefined
        );
        textNode.replace(documentReferenceNode);
        return documentReferenceNode;
    },
    trigger: ')',
    type: 'text-match',
};

/**
 * Legacy transformer for backward compatibility.
 * Imports old format: [[document:name|id]]
 * This transformer only imports - it never exports in this format.
 *
 * The old format stored an MD5 hash as the document ID, which we discard
 * since it's meaningless. We use the filename for everything.
 */
export const LegacyDocumentReferenceTransformer: TextMatchTransformer = {
    dependencies: [DocumentReferenceNode],
    export: () => null, // Never export in legacy format
    importRegExp: /\[\[document:([^|]+)\|([^\]]+)\]\]/,
    regExp: /(\[\[document:[^|]+\|[^\]]+\]\])$/,
    replace: (textNode, match) => {
        const [, name] = match;
        // Discard the MD5 hash (match[2]), use filename for id and path
        const documentReferenceNode = $createDocumentReferenceNode(name, name, name, undefined);
        textNode.replace(documentReferenceNode);
    },
    trigger: ']',
    type: 'text-match',
};
