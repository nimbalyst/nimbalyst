import type { JSX } from 'react';
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $isRangeSelection,
  $createParagraphNode,
  TextNode,
  $createTextNode,
  isDOMNode,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
  type RangeSelection,
} from 'lexical';
import { $isLinkNode, LinkNode } from '@lexical/link';
import { $createDocumentReferenceNode } from './DocumentLinkNode';
import { DocumentService } from '../../core/DocumentService';
import documentLinkStyles from './DocumentLinkPlugin.css?inline';
import { TypeaheadMenuOption } from "../../editor";
import { fuzzyFilterDocuments } from '../../utils/fuzzyMatch';
import { MaterialSymbol } from "../../ui";
import { $createEmbeddedFileNode } from '../../editor/plugins/EmbedPlugin/EmbeddedFileNode';
import { createEmbedFileHref } from '../../editor/plugins/EmbedPlugin/embedFilePaths';
import { isEmbeddableUrl } from '../../editor/plugins/EmbedPlugin/embeddableExtensions';
import { useDocumentPath } from '../../DocumentPathContext';
import {
  $insertMentionOption,
  buildMentionOptions,
  editorSupportsMentions,
  type MentionMember,
} from '../../editor/plugins/MentionPlugin/mentionTypeahead';
import {
  resolveDocumentLinkLookupPaths,
  isCollabReferenceHref,
  parseCollabReferenceDocumentId,
} from './documentLinkPaths';
import { isWorkspaceFileHref } from '../../editor/utils/workspaceLinkNavigation';
import {
  dispatchAppActionHref,
  isAppActionHref,
} from '../../utils/appActionLinks';

/**
 * A shared/collaborative document the `@` typeahead can reference when the
 * active editor is a collaborative document. `target` is the reference link
 * stored on the node (a `nimbalyst://doc/{id}?orgId={org}` deep link) and is
 * what the click handler passes back to {@link CollabReferenceSource.openReference}.
 */
export interface CollabReferenceOption {
  documentId: string;
  title: string;
  target: string;
  /** Folder breadcrumb ("Design/Specs") shown as secondary text; optional. */
  folderPath?: string;
  /**
   * File extension of the shared document (".mockup.html", ".excalidraw"),
   * when the host knows it. A collab deep link carries no extension, so this
   * is the only way the embed rule can tell a shared mockup from a shared
   * markdown doc -- it becomes the `embedType` attribute on the inserted node
   * and travels with the link through markdown (NIM-2473).
   */
  embedType?: string;
  /** Material symbol shown beside it; a team page's `groups` when absent. */
  icon?: string;
}

/**
 * Injected by the host when the current editor is a page (team or Personal),
 * or to add pages to a local file's list. When present, the `@` typeahead
 * lists this source's pages, and reference clicks on their targets open them.
 */
export interface CollabReferenceSource {
  /** Enumerate the linkable pages (already excludes the current one). */
  listOptions(): CollabReferenceOption[];
  /** Open a page from its reference target (deep link / collab URI / console link). */
  /** `newTab` when the click asked for one (Cmd/Ctrl, or the middle button). */
  openReference(target: string, options?: { newTab: boolean }): void;
  /** Whether a reference target is one of this source's; a shared-doc link when absent. */
  ownsTarget?(target: string): boolean;
  /** List the workspace's files after this source's pages (a local file's `@`). */
  includeLocalFiles?: boolean;
}

function sourceOwnsTarget(source: CollabReferenceSource, target: string | null | undefined): boolean {
  if (!target) return false;
  return source.ownsTarget ? source.ownsTarget(target) : isCollabReferenceHref(target);
}

/**
 * Insert a shared-document reference at the selection.
 *
 * Shared by the `@` typeahead and by pasting a copied link, so the two produce
 * the same node rather than two things that merely look alike. A shared
 * document whose type an extension can render inline gets the same block embed
 * a local file of that type would. The deep link has no extension, so the embed
 * rule is driven by the host-supplied `embedType`, which is also recorded on
 * the node so the hint survives export to markdown and the Y.Doc round trip
 * (NIM-2473).
 */
function $insertCollabReference(
  selection: RangeSelection,
  doc: ReferenceDoc,
  collabTarget: string,
): void {
  if (isEmbeddableUrl(collabTarget, doc.collabEmbedType)) {
    $insertEmbedBlock(selection, {
      src: collabTarget,
      label: doc.name,
      attrs: doc.collabEmbedType ? { embedType: doc.collabEmbedType } : {},
    });
    return;
  }

  const collabNode = $createDocumentReferenceNode(doc.id, doc.name, collabTarget);
  selection.insertNodes([collabNode]);
  const trailingSpace = $createTextNode(' ');
  collabNode.insertAfter(trailingSpace);
  trailingSpace.select();
}

/**
 * A pasted shared-document link becomes the reference it names.
 *
 * Until this existed the `@` typeahead was the only thing that ever created a
 * `DocumentReferenceNode`, so copying a document's link and pasting it left
 * inert text -- the one gesture a reader is most likely to try (NIM-3585).
 *
 * Only an exact plain-text paste is intercepted. Pasting a sentence that
 * happens to contain a link keeps the browser's normal text behavior, matching
 * how the message composer treats the same gesture.
 *
 * A link whose document this reader cannot see falls through to plain text
 * rather than minting a node with a guessed label. The label is baked into the
 * node and exported into markdown, so a wrong one outlives the paste; text is
 * the honest result when the title is genuinely unknown.
 */
function CollabReferencePastePlugin({
  collabReferenceSource,
}: {
  collabReferenceSource: CollabReferenceSource;
}): null {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event: ClipboardEvent) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData || clipboardData.files.length > 0) return false;

          const value = clipboardData.getData('text/plain').trim();
          if (!sourceOwnsTarget(collabReferenceSource, value)) return false;

          const documentId = parseCollabReferenceDocumentId(value);

          // Read the source at paste time rather than the typeahead's cached
          // list: `listOptions` is a synchronous read of live atoms, and the
          // cached list is only populated once a typeahead has been opened.
          const options = collabReferenceSource.listOptions();
          // Match on the target first -- it is the exact string the source
          // handed out. The id is the fallback for a link copied before the
          // target's query string changed shape.
          const known = options.find((option) => option.target === value)
            ?? (documentId ? options.find((option) => option.documentId === documentId) : undefined);
          if (!known) return false;

          event.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            $insertCollabReference(
              selection,
              {
                id: known.documentId,
                name: known.title,
                path: known.folderPath ?? '',
                collabTarget: known.target,
                folderPath: known.folderPath,
                collabEmbedType: known.embedType,
                collabIcon: known.icon,
              },
              known.target,
            );
          });
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, collabReferenceSource],
  );

  return null;
}

/** Internal unified shape feeding the typeahead option list + selection. */
interface ReferenceDoc {
  id: string;
  name: string;
  path: string;
  workspace?: string;
  /** Present only for collab references; the reference link stored on the node. */
  collabTarget?: string;
  /** Present only for collab references; folder breadcrumb for display. */
  folderPath?: string;
  /** Present only for collab references; the shared document's file extension. */
  collabEmbedType?: string;
  /** Present only for collab references; the symbol shown beside it. */
  collabIcon?: string;
}

const DOCUMENT_REFERENCE_STYLE_ID = 'document-reference-styles';

/**
 * Insert an embed at the caret. `EmbeddedFileNode` is block-level, so it goes
 * in as a sibling of the current top-level block with a trailing paragraph for
 * the caret to land in. If that block is now empty (the typeahead stripped the
 * trigger and the line held nothing else) it is dropped, so the embed doesn't
 * sit under a blank line.
 */
function $insertEmbedBlock(
  selection: RangeSelection,
  embed: { src: string; label: string; attrs: Record<string, string> },
): void {
  const embedNode = $createEmbeddedFileNode(embed);
  const block = selection.anchor.getNode().getTopLevelElementOrThrow();
  block.insertAfter(embedNode);
  const trailing = $createParagraphNode();
  embedNode.insertAfter(trailing);
  trailing.select();
  if (block.getChildrenSize() === 0) {
    block.remove();
  }
}

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

/**
 * Plain `<a>` links whose raw href is a file path (relative markdown links
 * that were imported as LinkNodes rather than DocumentReferenceNodes, e.g.
 * when the link text carries inline-code formatting). These must be opened
 * through the document service like reference chips; letting them reach
 * Lexical's ClickableLink handling ends in `window.open('./x')` and a blank
 * Electron child window (NIM-1487).
 */
function getWorkspaceFileAnchor(target: Node): HTMLAnchorElement | null {
  const targetElement =
    typeof Element !== 'undefined' && target instanceof Element
      ? target
      : target.parentElement;

  const anchor = targetElement?.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }
  // getAttribute keeps the authored href; anchor.href would be resolved
  // against the renderer origin and always look external.
  return isWorkspaceFileHref(anchor.getAttribute('href')) ? anchor : null;
}

function getAppActionHref(
  target: Node,
  editor: LexicalEditor,
): string | null {
  const targetElement =
    typeof Element !== 'undefined' && target instanceof Element
      ? target
      : target.parentElement;
  const anchor = targetElement?.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }

  const renderedHref = anchor.getAttribute('href');
  if (isAppActionHref(renderedHref)) {
    return renderedHref;
  }

  // Lexical sanitizes non-web LinkNode schemes to `about:blank` in the DOM.
  // Read the authored URL from the backing node so the reserved app-action
  // namespace can still be intercepted before ClickableLink opens it.
  return editor.read(() => {
    let lexicalNode = $getNearestNodeFromDOMNode(anchor);
    while (lexicalNode && !$isLinkNode(lexicalNode)) {
      lexicalNode = lexicalNode.getParent();
    }
    if (!$isLinkNode(lexicalNode)) {
      return null;
    }
    const authoredHref = lexicalNode.getURL();
    return isAppActionHref(authoredHref) ? authoredHref : null;
  });
}

/**
 * Put the authored path back on workspace-file anchors.
 *
 * Lexical builds a LinkNode's `href` with `sanitizeUrl` -> `formatUrl`, which
 * prefixes any URL that lacks a scheme and doesn't start with `/`, `.`, or `#`
 * with `https://`. So `[brief](documents/brief.md)` renders as
 * `href="https://documents/brief.md"`, and every DOM-level consumer then reads
 * it as an external web link — the renderer's global link handler sends it to
 * the user's browser as a broken URL. The node keeps the authored URL, so
 * markdown export is unaffected; only the rendered attribute is wrong.
 */
function registerWorkspaceFileHrefRepair(editor: LexicalEditor): () => void {
  const repairKeys = (keys: Iterable<string>) => {
    editor.getEditorState().read(() => {
      for (const key of keys) {
        const node = $getNodeByKey(key);
        if (!$isLinkNode(node)) continue;
        const authoredUrl = node.getURL();
        if (!isWorkspaceFileHref(authoredUrl)) continue;
        const element = editor.getElementByKey(key);
        if (
          element instanceof HTMLAnchorElement &&
          element.getAttribute('href') !== authoredUrl
        ) {
          element.setAttribute('href', authoredUrl);
        }
      }
    });
  };

  return editor.registerMutationListener(
    LinkNode,
    (mutations) => {
      const changed: string[] = [];
      for (const [key, mutation] of mutations) {
        if (mutation !== 'destroyed') changed.push(key);
      }
      if (changed.length > 0) repairKeys(changed);
    },
    // Links present in the initial editor state (every markdown document that
    // is opened, not just ones edited afterwards) must be repaired too.
    { skipInitialization: false },
  );
}

interface DocumentLinkPluginProps {
  documentService: DocumentService;
  TypeaheadMenuPlugin: React.ComponentType<any>;
  // Precomputed trigger function (created via useBasicTypeaheadTriggerMatch in the host)
  triggerFn: any;
  // Optional anchor element to render the menu within
  anchorElem?: HTMLElement | null;
  /**
   * When set, `@` suggests this source's pages (instead of local workspace
   * files, unless it sets `includeLocalFiles`), and reference clicks on its
   * targets open the page. Absent: local files only.
   */
  collabReferenceSource?: CollabReferenceSource | null;
  /**
   * The people `@` offers as mention chips, read when the query changes.
   * Absent: no people (dates are always offered where chips are supported).
   */
  getMentionMembers?: () => MentionMember[];
}

export function DocumentLinkPlugin({
  documentService,
  TypeaheadMenuPlugin,
  triggerFn,
  anchorElem,
  collabReferenceSource,
  getMentionMembers,
}: DocumentLinkPluginProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const { documentPath: currentDocumentPath } = useDocumentPath();
  const [queryString, setQueryString] = useState<string>('');
  const [documents, setDocuments] = useState<ReferenceDoc[]>([]);
  const localFilesRef = useRef<ReferenceDoc[]>([]);
  const menuOpenRef = useRef(false);
  const lastFetchTimeRef = useRef<number>(0);
  const CACHE_DURATION_MS = 5000; // 5 second cache

  useEffect(() => registerWorkspaceFileHrefRepair(editor), [editor]);

  useEffect(() => {
    const handleDocumentReferenceClick = (event: MouseEvent, allowButton: (button: number) => boolean) => {
      if (event.defaultPrevented || !allowButton(event.button)) {
        return;
      }

      const target = event.target;
      if (!isDOMNode(target)) {
        return;
      }

      const appActionHref = getAppActionHref(target, editor);
      if (appActionHref) {
        const selectionPreventsNavigation = editor
          .getEditorState()
          .read(() => {
            const selection = $getSelection();
            return $isRangeSelection(selection) && !selection.isCollapsed();
          });

        event.preventDefault();
        event.stopPropagation();
        if (!selectionPreventsNavigation) {
          dispatchAppActionHref(appActionHref);
        }
        return;
      }

      let documentId: string | null = null;
      let documentPath: string | undefined;
      let documentName: string | undefined;

      const referenceElement = getDocumentReferenceElement(target);
      if (referenceElement) {
        documentId = referenceElement.getAttribute('data-document-id');
        documentPath = referenceElement.getAttribute('data-path') || undefined;
        documentName = referenceElement.getAttribute('data-name') || referenceElement.textContent || undefined;
      } else {
        const anchor = getWorkspaceFileAnchor(target);
        if (!anchor) {
          return;
        }
        documentPath = anchor.getAttribute('href') || undefined;
        documentName = anchor.textContent || undefined;
        // Keep the event away from ClickableLink / Lexical's CLICK_COMMAND —
        // both end in window.open for LinkNodes.
        event.stopPropagation();
      }

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

      // Collaborative references store a collab-scheme target (deep link /
      // collab URI) instead of a workspace-relative path. Route them through
      // the collab opener; the local document-service path would fail to
      // resolve them and could spawn a blank window.
      if (collabReferenceSource && sourceOwnsTarget(collabReferenceSource, documentPath)) {
        collabReferenceSource.openReference(documentPath!, { newTab: event.button === 1 || event.metaKey || event.ctrlKey });
        return;
      }
      if (isCollabReferenceHref(documentPath)) {
        console.warn('[DocumentLinkPlugin] Collab reference clicked with no collab source available', documentPath);
        return;
      }

      const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath ?? null;
      const candidatePaths = documentPath
        ? resolveDocumentLinkLookupPaths(documentPath, currentDocumentPath, workspacePath)
        : [];
      const fallbackPath = candidatePaths[candidatePaths.length - 1];

      void (async () => {
        for (const candidate of candidatePaths) {
          const resolvedDoc = await documentService.getDocumentByPath(candidate);
          if (resolvedDoc) {
            await documentService.openDocument(resolvedDoc.id, {
              path: resolvedDoc.path,
            });
            return;
          }
        }

        await documentService.openDocument(fallbackPath ? '' : (documentId ?? ''), {
          path: fallbackPath ?? documentPath,
          name: fallbackPath ? undefined : documentName,
        });
      })().catch(error => {
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
  }, [currentDocumentPath, editor, documentService, collabReferenceSource]);

  // Load documents only when menu opens, with cache
  const loadDocuments = useCallback(async () => {
    // A page: suggest the source's pages instead of local files. The source is
    // already computed from live atoms, so no fetch/cache needed.
    const pages = collabReferenceSource
      ? collabReferenceSource.listOptions().map((opt): ReferenceDoc => ({
        id: opt.documentId,
        name: opt.title,
        // fuzzy matcher ranks on name + path; folder breadcrumb feeds path.
        path: opt.folderPath ?? '',
        collabTarget: opt.target,
        folderPath: opt.folderPath,
        collabEmbedType: opt.embedType,
        collabIcon: opt.icon,
      }))
      : [];
    if (collabReferenceSource && !collabReferenceSource.includeLocalFiles) {
      setDocuments(pages);
      return;
    }

    const now = Date.now();
    const timeSinceLastFetch = now - lastFetchTimeRef.current;

    // Skip fetch if cache is still valid
    if (timeSinceLastFetch < CACHE_DURATION_MS && localFilesRef.current.length > 0) {
      setDocuments([...pages, ...localFilesRef.current]);
      return;
    }

    const docs = await documentService.listDocuments();
    localFilesRef.current = docs;
    setDocuments([...pages, ...docs]);
    lastFetchTimeRef.current = now;
  }, [documentService, collabReferenceSource]);

  // triggerFn is provided by the host; ensure stable reference via useMemo
  const resolvedTriggerFn = useMemo(() => triggerFn, [triggerFn]);

  // Generate document options based on search query with fuzzy matching
  const options = useMemo(() => {
    // Use fuzzy filtering with ranking
    const filtered = fuzzyFilterDocuments(documents, queryString, 50);
    const mentions = editorSupportsMentions(editor)
      ? buildMentionOptions(queryString, getMentionMembers?.() ?? [])
      : [];

    return [...mentions, ...filtered.map(({ item: doc, match }) => {
      // Collab references: `path` already holds the folder breadcrumb (a
      // directory), so show it directly. Local files: strip the filename to
      // show the parent directory.
      const displayDir = doc.collabTarget ? (doc.folderPath ?? '') : getDirectoryPath(doc.path);
      const truncatedPath = truncatePath(displayDir);

      return {
        id: `doc-${doc.id}`,
        label: doc.name,
        // Use secondaryText for single-line layout with path on the right
        secondaryText: truncatedPath || undefined,
        // Full path in tooltip for hover
        tooltip: doc.collabTarget ? (doc.folderPath || doc.name) : doc.path,
        icon: <MaterialSymbol style={{ fontSize: 16, verticalAlign: 'middle' }} icon={doc.collabTarget ? (doc.collabIcon ?? 'groups') : 'description'}/>,
        // Don't use sections - removes the heavy uppercase headers
        // section: doc.workspace || 'Documents',
        keywords: [doc.name, doc.workspace, doc.path].filter(Boolean) as string[],
        // Pass match info for potential highlighting
        matchedIndices: match.matchedIndices,
        score: match.score,
      };
    })];
  }, [queryString, documents, editor, getMentionMembers]);

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
      if ($insertMentionOption(selection, option.id)) return;

      const docId = option.id.replace('doc-', '');
      const doc = documents.find(d => d.id === docId);
      if (!doc) return;

      // Collaborative reference: the target is a shared-doc deep link.
      if (doc.collabTarget) {
        $insertCollabReference(selection, doc, doc.collabTarget);
        return;
      }

      // Markdown link paths always use forward slashes regardless of OS.
      const linkPath = doc.path.replace(/\\/g, '/');

      // Embeddable files use a block; other references stay inline.
      if (isEmbeddableUrl(linkPath)) {
        const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath ?? null;
        const src = createEmbedFileHref(linkPath, currentDocumentPath, workspacePath);
        $insertEmbedBlock(selection, { src, label: doc.name, attrs: {} });
        return;
      }

      const replacementNode = $createDocumentReferenceNode(
        doc.id,
        doc.name,
        linkPath,
        doc.workspace
      );

      selection.insertNodes([replacementNode]);

      const spaceNode = $createTextNode(' ');
      replacementNode.insertAfter(spaceNode);
      spaceNode.select();
    });

    closeMenu();
  }, [editor, documents, currentDocumentPath]);

  return (
    <>
      {collabReferenceSource && (
        <CollabReferencePastePlugin collabReferenceSource={collabReferenceSource} />
      )}
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
    </>
  );
}
