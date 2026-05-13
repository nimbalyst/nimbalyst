import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  TextNode,
  $createTextNode,
  isDOMNode
} from 'lexical';
import { $createDocumentReferenceNode } from './DocumentLinkNode';
import { DocumentService } from '../../core/DocumentService';
import documentLinkStyles from './DocumentLinkPlugin.css?inline';
import { TypeaheadMenuOption } from "../../editor";
import { fuzzyFilterDocuments } from '../../utils/fuzzyMatch';
import { MaterialSymbol } from "../../ui";
import { $createEmbeddedFileNode } from '../../editor/plugins/EmbedPlugin/EmbeddedFileNode';
import { isEmbeddableUrl } from '../../editor/plugins/EmbedPlugin/embeddableExtensions';

const DOCUMENT_REFERENCE_STYLE_ID = 'document-reference-styles';

/**
 * Truncate a path for display, keeping the most relevant parts visible.
 * Preserves the filename and shows abbreviated parent directories.
 * Example: "packages/electron/src/renderer/components" -> "...renderer/components"
 */
function truncatePath(path: string, maxLength: number = 40): string {
  if (!path || path.length <= maxLength) return path;

  const parts = path.split('/');
  if (parts.length <= 2) return path;

  // Always keep the last 2-3 parts (closest to the file)
  const keepParts = parts.slice(-3);
  const truncated = '...' + keepParts.join('/');

  if (truncated.length <= maxLength) return truncated;

  // If still too long, keep fewer parts
  const fewerParts = parts.slice(-2);
  return '...' + fewerParts.join('/');
}

/**
 * Get the directory path (without filename) from a full path
 */
function getDirectoryPath(fullPath: string): string {
  const parts = fullPath.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

function ensureDocumentReferenceStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(DOCUMENT_REFERENCE_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = DOCUMENT_REFERENCE_STYLE_ID;
  style.textContent = documentLinkStyles;
  document.head.appendChild(style);
}

ensureDocumentReferenceStyles();

function getDocumentReferenceElement(target: Node): Element | null {
  const targetElement =
    typeof Element !== 'undefined' && target instanceof Element
      ? target
      : target.parentElement;

  return targetElement?.closest('.document-reference') ?? null;
}

interface DocumentLinkPluginProps {
  documentService: DocumentService;
  TypeaheadMenuPlugin: React.ComponentType<any>;
  // Precomputed trigger function (created via useBasicTypeaheadTriggerMatch in the host)
  triggerFn: any;
  // Optional anchor element to render the menu within
  anchorElem?: HTMLElement | null;
}

export function DocumentLinkPlugin({
  documentService,
  TypeaheadMenuPlugin,
  triggerFn,
  anchorElem,
}: DocumentLinkPluginProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [queryString, setQueryString] = useState<string>('');
  const [documents, setDocuments] = useState<any[]>([]);
  const menuOpenRef = useRef(false);
  const lastFetchTimeRef = useRef<number>(0);
  const CACHE_DURATION_MS = 5000; // 5 second cache

  useEffect(() => {
    const handleDocumentReferenceClick = (event: MouseEvent, allowButton: (button: number) => boolean) => {
      if (event.defaultPrevented || !allowButton(event.button)) {
        return;
      }

      const target = event.target;
      if (!isDOMNode(target)) {
        return;
      }

      const referenceElement = getDocumentReferenceElement(target);
      if (!referenceElement) {
        return;
      }

      const documentId = referenceElement.getAttribute('data-document-id');
      const documentPath = referenceElement.getAttribute('data-path') || undefined;
      const documentName = referenceElement.getAttribute('data-name') || referenceElement.textContent || undefined;
      if (!documentId && !documentPath) {
        return;
      }

      const selectionPreventsNavigation = editor
        .getEditorState()
        .read(() => {
          const selection = $getSelection();
          return $isRangeSelection(selection) && !selection.isCollapsed();
        });

      if (selectionPreventsNavigation) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      try {
        if (documentId) {
          console.log('[DocumentLinkPlugin] Opening document reference', documentId);
        } else if (documentPath) {
          console.log('[DocumentLinkPlugin] Opening document reference by path', documentPath);
        }
      } catch {}

      void documentService
        .openDocument(documentId ?? '', { path: documentPath, name: documentName })
        .catch(error => {
          console.error('Failed to open document reference', error);
        });
    };

    const onClick = (event: MouseEvent) => handleDocumentReferenceClick(event, (button) => button === 0);
    const onAuxClick = (event: MouseEvent) => handleDocumentReferenceClick(event, (button) => button === 1);

    return editor.registerRootListener((rootElement, prevRootElement) => {
      if (prevRootElement) {
        prevRootElement.removeEventListener('click', onClick, true);
        prevRootElement.removeEventListener('auxclick', onAuxClick, true);
      }
      if (rootElement) {
        rootElement.addEventListener('click', onClick, true);
        rootElement.addEventListener('auxclick', onAuxClick, true);
        return () => {
          rootElement.removeEventListener('click', onClick, true);
          rootElement.removeEventListener('auxclick', onAuxClick, true);
        };
      }
      return undefined;
    });
  }, [editor, documentService]);

  // Load documents only when menu opens, with cache
  const loadDocuments = useCallback(async () => {
    const now = Date.now();
    const timeSinceLastFetch = now - lastFetchTimeRef.current;

    // Skip fetch if cache is still valid
    if (timeSinceLastFetch < CACHE_DURATION_MS && documents.length > 0) {
      return;
    }

    const docs = await documentService.listDocuments();
    setDocuments(docs);
    lastFetchTimeRef.current = now;
  }, [documentService, documents.length]);

  // triggerFn is provided by the host; ensure stable reference via useMemo
  const resolvedTriggerFn = useMemo(() => triggerFn, [triggerFn]);

  // Generate document options based on search query with fuzzy matching
  const options = useMemo(() => {
    // Use fuzzy filtering with ranking
    const filtered = fuzzyFilterDocuments(documents, queryString, 50);

    return filtered.map(({ item: doc, match }) => {
      const dirPath = getDirectoryPath(doc.path);
      const truncatedPath = truncatePath(dirPath);

      return {
        id: `doc-${doc.id}`,
        label: doc.name,
        // Use secondaryText for single-line layout with path on the right
        secondaryText: truncatedPath || undefined,
        // Full path in tooltip for hover
        tooltip: doc.path,
        icon: <MaterialSymbol style={{ fontSize: 16, verticalAlign: 'middle' }} icon={'description'}/>,
        // Don't use sections - removes the heavy uppercase headers
        // section: doc.workspace || 'Documents',
        keywords: [doc.name, doc.workspace, doc.path].filter(Boolean) as string[],
        // Pass match info for potential highlighting
        matchedIndices: match.matchedIndices,
        score: match.score,
      };
    });
  }, [queryString, documents]);

  const handleQueryChange = useCallback((query: string | null) => {
    setQueryString(query || '');
  }, []);

  const handleSelectOption = useCallback((
    option: TypeaheadMenuOption,
    _textNode: TextNode | null,
    closeMenu: () => void,
    _matchingString: string
  ) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      const docId = option.id.replace('doc-', '');
      const doc = documents.find(d => d.id === docId);
      if (!doc) return;

      // Markdown link paths always use forward slashes regardless of OS.
      const linkPath = doc.path.replace(/\\/g, '/');

      // Embeddable files (e.g. `.excalidraw`) get inserted as block-level
      // EmbeddedFileNodes so they render inline immediately. Other files
      // use the existing inline DocumentReferenceNode.
      if (isEmbeddableUrl(linkPath)) {
        const embedNode = $createEmbeddedFileNode({
          src: linkPath,
          label: doc.name,
          attrs: {},
        });
        // EmbeddedFileNode is block-level. Insert as a sibling of the
        // current top-level block, then add a trailing paragraph so the
        // caret has somewhere to land. If the original block is now empty
        // (typeahead stripped the trigger and the line had nothing else),
        // drop it so we don't leave a blank line above the embed.
        const block = selection.anchor.getNode().getTopLevelElementOrThrow();
        block.insertAfter(embedNode);
        const trailing = $createParagraphNode();
        embedNode.insertAfter(trailing);
        trailing.select();
        if (block.getChildrenSize() === 0) {
          block.remove();
        }
        return;
      }

      const replacementNode = $createDocumentReferenceNode(
        doc.id,
        doc.name,
        doc.path,
        doc.workspace
      );

      // Typeahead has already removed the trigger text; just insert at caret
      selection.insertNodes([replacementNode]);

      // Add a trailing space and place cursor after it
      const spaceNode = $createTextNode(' ');
      replacementNode.insertAfter(spaceNode);
      spaceNode.select();
    });

    closeMenu();
  }, [editor, documents]);

  return (
    <TypeaheadMenuPlugin
      options={options}
      triggerFn={resolvedTriggerFn}
      onQueryChange={handleQueryChange}
      onSelectOption={handleSelectOption}
      anchorElem={anchorElem}
      minWidth={350}
      maxWidth={500}
      maxHeight={400}
      onOpen={() => {
        menuOpenRef.current = true;
        loadDocuments();
      }}
      onClose={() => {
        menuOpenRef.current = false;
      }}
    />
  );
}
