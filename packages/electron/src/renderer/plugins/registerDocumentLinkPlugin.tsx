/**
 * Wire up the runtime's DocumentLinkPlugin against the electron document
 * service and publish it as a renderer-contributed Lexical UI plugin.
 *
 * The plugin's headless concerns (markdown transformers, the
 * `DocumentReferenceNode` registration) come from
 * `registerDocumentReferenceContributions`, shared with every other host that
 * opens a document — a host missing the node class cannot decode a Y.Doc that
 * contains one.
 */

import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  TypeaheadMenuPlugin,
  registerExtensionEditorComponent,
  setWorkspaceFileLinkOpener,
  useAnchorElem,
  useDocumentPath,
} from '@nimbalyst/runtime';
import {
  DOCUMENT_LINK_SOURCE,
  registerDocumentReferenceContributions,
} from '@nimbalyst/runtime/plugins/referenceNodeContributions';
import {
  DocumentLinkPlugin,
  type CollabReferenceSource,
} from '@nimbalyst/runtime/plugins/DocumentLinkPlugin';
import {
  resolveDocumentLinkLookupPaths,
  parseCollabReferenceDocumentId,
} from '@nimbalyst/runtime/plugins/DocumentLinkPlugin/documentLinkPaths';
import { ElectronRendererDocumentService } from '../services/ElectronDocumentService';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';
import {
  sharedDocumentsAtom,
  sharedFoldersAtom,
  activeCollabScopeAtom,
  buildSharedDocumentDeepLink,
  pendingCollabDocumentAtom,
  type SharedDocument,
  type SharedFolder,
} from '../store/atoms/collabDocuments';
import { setWindowModeAtom } from '../store/atoms/windowMode';
import { getCollaborativeDocumentTypeCatalog } from '../services/CollaborativeDocumentTypeCatalog';
import { store } from '../store';

const SOURCE = DOCUMENT_LINK_SOURCE;
const documentService = new ElectronRendererDocumentService();

// Custom trigger function that allows dots and hyphens in filenames so
// `@README.md` and `@settings-atomwithstorage-rewrite.excalidraw` both
// keep the typeahead open as the user types. Punctuation that would end a
// reasonable filename token (parens, brackets, quotes, etc.) still ends
// the match so the menu closes when the user moves on to other prose.
function createDocumentLinkTrigger(trigger: string, { minLength = 0, maxLength = 75 }) {
  const FILENAME_TERMINATORS = String.raw`\,\+\*\?\$\|#{}\(\)\^\[\]\\\/!%'"~=<>:;`;
  return (text: string) => {
    const validChars = '[^' + trigger + FILENAME_TERMINATORS + '\\s]';
    const regex = new RegExp(
      '(^|\\s|\\()(' +
        '[' +
        trigger +
        ']' +
        '((?:' +
        validChars +
        '){0,' +
        maxLength +
        '})' +
        ')$',
    );
    const match = regex.exec(text);
    if (match !== null) {
      const maybeLeadingWhitespace = match[1];
      const matchingString = match[3];
      if (matchingString.length >= minLength) {
        return {
          leadOffset: match.index + maybeLeadingWhitespace.length,
          matchingString,
          replaceableString: match[2],
        };
      }
    }
    return null;
  };
}

/**
 * Resolve each folderId to its full breadcrumb ("Design/Specs") from the
 * first-class folder tree, so shared-doc suggestions can show where the doc
 * lives. Guards against cycles.
 */
function buildFolderBreadcrumbs(folders: SharedFolder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const cache = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const folder = byId.get(id);
    if (!folder || seen.has(id)) return '';
    seen.add(id);
    const parent = folder.parentFolderId ? resolve(folder.parentFolderId, seen) : '';
    const path = parent ? `${parent}/${folder.name}` : folder.name;
    cache.set(id, path);
    return path;
  };
  for (const folder of folders) {
    resolve(folder.folderId, new Set());
  }
  return cache;
}

/**
 * File extension for a shared document, used to decide whether an `@`
 * reference to it should become a live embed. Documents shared before the
 * metadata existed carry no `fileExtension`, so fall back to the title (docs
 * shared from a local file keep their basename) and then to the document
 * type's default extension.
 */
function sharedDocumentFileExtension(doc: SharedDocument): string | undefined {
  if (doc.fileExtension) return doc.fileExtension;
  const catalog = getCollaborativeDocumentTypeCatalog();
  const inferred = catalog.inferFileExtension(doc.documentType, doc.title || '');
  if (inferred) return inferred;
  const resolution = catalog.resolveMetadata(
    doc.documentType,
    undefined,
    doc.editorId,
  );
  return resolution.state === 'ready'
    ? resolution.descriptor.defaultExtension
    : undefined;
}

function DocumentLinkPluginWrapper() {
  const triggerFn = useMemo(
    () => createDocumentLinkTrigger('@', { minLength: 0, maxLength: 75 }),
    [],
  );
  const anchorElem = useAnchorElem();

  // Collaborative-document awareness: when the active editor is a collab doc,
  // `@` should suggest shared documents rather than local workspace files.
  const { documentPath } = useDocumentPath();
  const isCollab = documentPath ? isCollabUri(documentPath) : false;
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const scope = useAtomValue(activeCollabScopeAtom);

  const collabReferenceSource = useMemo<CollabReferenceSource | null>(() => {
    if (!isCollab || !scope || !documentPath) {
      return null;
    }

    let currentDocumentId: string | undefined;
    try {
      currentDocumentId = parseCollabUri(documentPath).documentId;
    } catch {
      currentDocumentId = undefined;
    }

    const breadcrumbs = buildFolderBreadcrumbs(sharedFolders);

    return {
      listOptions: () =>
        sharedDocuments
          .filter((doc) => !doc.decryptFailed && doc.documentId !== currentDocumentId)
          .map((doc) => ({
            documentId: doc.documentId,
            title: doc.title || 'Untitled',
            target: buildSharedDocumentDeepLink(doc.documentId, scope.orgId),
            folderPath: doc.parentFolderId
              ? breadcrumbs.get(doc.parentFolderId) || undefined
              : undefined,
            // Lets the plugin insert a shared mockup/diagram as a live embed
            // rather than a plain reference.
            embedType: sharedDocumentFileExtension(doc),
          })),
      openReference: (target: string) => {
        const targetDocumentId = parseCollabReferenceDocumentId(target);
        if (!targetDocumentId) return;

        // The Lexical plugin renders outside any TabsProvider, so it can't add
        // a tab directly. Route through the same shared-document open flow the
        // deep-link handler uses: switch to collab mode and hand the doc id to
        // the pending atom. CollabMode consumes it, opening (or focusing) the
        // shared doc with its own tab context + dedup.
        store.set(setWindowModeAtom, 'collab');
        store.set(pendingCollabDocumentAtom, {
          documentId: targetDocumentId,
          scopeKey: scope.scopeKey,
          orgId: scope.orgId,
          analyticsSource: 'deep_link',
        });
      },
    };
  }, [isCollab, scope, documentPath, sharedDocuments, sharedFolders]);

  return (
    <DocumentLinkPlugin
      documentService={documentService}
      TypeaheadMenuPlugin={TypeaheadMenuPlugin as React.ComponentType<unknown>}
      triggerFn={triggerFn}
      anchorElem={anchorElem || undefined}
      collabReferenceSource={collabReferenceSource}
    />
  );
}

export function registerDocumentLinkPlugin(): void {
  // Route file-path links (from the floating link editor and plain LinkNodes)
  // through the document service instead of window.open, which would spawn a
  // blank Electron child window (NIM-1487).
  setWorkspaceFileLinkOpener((rawHref, currentDocumentPath) => {
    const workspacePath =
      (window as unknown as { __workspacePath?: string }).__workspacePath ?? null;
    const candidatePaths = resolveDocumentLinkLookupPaths(
      rawHref,
      currentDocumentPath,
      workspacePath,
    );
    void (async () => {
      for (const candidate of candidatePaths) {
        const resolvedDoc = await documentService.getDocumentByPath(candidate);
        if (resolvedDoc) {
          await documentService.openDocument(resolvedDoc.id, { path: resolvedDoc.path });
          return;
        }
      }
      const fallbackPath = candidatePaths[candidatePaths.length - 1];
      await documentService.openDocument('', { path: fallbackPath || rawHref });
    })().catch((error) => {
      console.error('Failed to open workspace file link', rawHref, error);
    });
  });

  registerDocumentReferenceContributions();
  registerExtensionEditorComponent({
    name: SOURCE,
    Component: DocumentLinkPluginWrapper as React.ComponentType<unknown>,
  });
}
