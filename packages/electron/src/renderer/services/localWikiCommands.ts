/**
 * Where a Local section command goes. The section shows the wiki folder
 * (through `@nimbalyst/local-wiki` in main) plus the database Personal pages
 * the user has not exported yet. A command on one of those database rows keeps
 * going to the old `personal-pages:command` path; everything else becomes a
 * library command. Commands that would join the two (a new page under a
 * database page, a move across) are refused: export first.
 *
 * A type page's description (`type-page:<typeId>`) is not a page of the tree
 * and stays in the database store until type descriptions become files, so
 * every command on one goes there, wherever its type sits.
 */
import { TYPE_PAGE_DOCUMENT_PREFIX, type CollabDocsCommand } from '@nimbalyst/collab-client/docs';
import type { LocalWikiCommand } from '@nimbalyst/local-wiki';
import { localPageWikiTitle, personalPageSupportsType } from './personalPageTypes';

export interface LegacyIds {
  documents: ReadonlySet<string>;
  types: ReadonlySet<string>;
  items: ReadonlySet<string>;
}

export type LocalCommandRoute =
  | { backend: 'none' }
  | { backend: 'legacy' }
  | { backend: 'wiki'; command: LocalWikiCommand };

export function isTypePageDocumentId(documentId: string): boolean {
  return documentId.startsWith(TYPE_PAGE_DOCUMENT_PREFIX);
}

const EXPORT_FIRST = 'is a database page that has not been exported to files yet; use Export in the Local section menu first';

function refuseLegacyParent(parentId: string | null | undefined, legacy: LegacyIds): void {
  if (parentId && legacy.documents.has(parentId)) {
    throw new Error(`The parent page ${EXPORT_FIRST}`);
  }
}

function wiki(command: LocalWikiCommand): LocalCommandRoute {
  return { backend: 'wiki', command };
}

/**
 * `editorPages` maps each editor page (drawing, mind map...) to its file
 * suffix: the tree shows its title with the suffix, the wiki stores the stem.
 */
export function routeLocalCommand(
  command: CollabDocsCommand,
  legacy: LegacyIds,
  editorPages: ReadonlyMap<string, string> = new Map(),
): LocalCommandRoute {
  const legacyDocument = (id: string) => legacy.documents.has(id) || isTypePageDocumentId(id);
  const wikiTitle = (id: string, title: string) => localPageWikiTitle(title, editorPages.get(id));
  switch (command.type) {
    case 'refresh-folders':
    case 'refresh-type-placements':
    case 'refresh-item-placements':
    case 'reconnect':
      return { backend: 'none' };

    case 'register-document': {
      if (isTypePageDocumentId(command.documentId)) return { backend: 'legacy' };
      refuseLegacyParent(command.parentFolderId, legacy);
      const documentType = command.documentType ?? 'markdown';
      if (!personalPageSupportsType(documentType)) {
        throw new Error(`Local pages cannot be ${documentType} files; a ${documentType} page belongs in the Team section`);
      }
      const fileExtension = documentType === 'markdown' ? undefined : command.metadata?.fileExtension;
      return wiki({
        type: 'register-document',
        documentId: command.documentId,
        title: localPageWikiTitle(command.title, fileExtension),
        parentFolderId: command.parentFolderId ?? null,
        ...(command.parentKind ? { parentKind: command.parentKind } : {}),
        sortOrder: command.sortOrder ?? null,
        ...(documentType === 'markdown' ? {} : { documentType, ...(fileExtension ? { fileExtension } : {}) }),
      });
    }
    case 'register-folder':
      refuseLegacyParent(command.parentFolderId, legacy);
      return wiki({ type: 'register-document', documentId: command.folderId, title: command.name, parentFolderId: command.parentFolderId ?? null });

    case 'update-document-title':
      return legacyDocument(command.documentId)
        ? { backend: 'legacy' }
        : wiki({ ...command, title: wikiTitle(command.documentId, command.title) });
    case 'rename-folder':
      return legacyDocument(command.folderId)
        ? { backend: 'legacy' }
        : wiki({ type: 'update-document-title', documentId: command.folderId, title: wikiTitle(command.folderId, command.name) });
    case 'set-document-fields':
      return legacyDocument(command.documentId) ? { backend: 'legacy' } : wiki(command);
    case 'trash-document':
      return legacyDocument(command.documentId)
        ? { backend: 'legacy' }
        : wiki({ type: 'trash-document', documentId: command.documentId, trashedAt: command.trashedAt });
    case 'restore-document':
      return legacyDocument(command.documentId) ? { backend: 'legacy' } : wiki(command);
    case 'remove-document':
      return legacyDocument(command.documentId)
        ? { backend: 'legacy' }
        : wiki({ type: 'remove-document', documentId: command.documentId, ...(command.purge ? { purge: true as const } : {}) });
    case 'remove-folder':
      // The library trashes a page with its folder, and purges it with what is below.
      return legacyDocument(command.folderId)
        ? { backend: 'legacy' }
        : wiki({ type: 'remove-document', documentId: command.folderId, ...(command.purge ? { purge: true as const } : {}) });

    case 'move-document':
    case 'move-folder': {
      const id = command.type === 'move-document' ? command.documentId : command.folderId;
      const parentId = command.parentFolderId ?? null;
      const parentIsLegacy = Boolean(parentId && legacyDocument(parentId));
      if (isTypePageDocumentId(id)) return { backend: 'legacy' };
      if (legacyDocument(id)) {
        if (parentId && !parentIsLegacy) throw new Error(`This page ${EXPORT_FIRST}`);
        return { backend: 'legacy' };
      }
      refuseLegacyParent(parentId, legacy);
      return wiki({
        type: 'move-document',
        documentId: id,
        parentFolderId: parentId,
        ...(command.type === 'move-document' && command.parentKind ? { parentKind: command.parentKind } : {}),
        ...(command.type === 'move-document' && command.sortOrder !== undefined ? { sortOrder: command.sortOrder } : {}),
      });
    }

    case 'set-type-placement':
      if (legacy.types.has(command.typeId)) return { backend: 'legacy' };
      refuseLegacyParent(command.parentFolderId, legacy);
      return wiki({
        type: 'set-type-placement',
        typeId: command.typeId,
        parentFolderId: command.parentFolderId ?? null,
        sortOrder: command.sortOrder,
        ...(command.parentKind ? { parentKind: command.parentKind } : {}),
      });
    case 'remove-type-placement':
      if (legacy.types.has(command.typeId)) return { backend: 'legacy' };
      throw new Error('A table type in the Local wiki is a CSV file in the wiki folder; move it instead of removing it');

    case 'set-item-placement':
      if (legacy.items.has(command.itemId)) return { backend: 'legacy' };
      refuseLegacyParent(command.parentId, legacy);
      return wiki({
        type: 'set-item-placement',
        itemId: command.itemId,
        parentId: command.parentId ?? null,
        sortOrder: command.sortOrder,
        ...(command.parentKind ? { parentKind: command.parentKind } : {}),
      });
    case 'remove-item-placement':
      if (legacy.items.has(command.itemId)) return { backend: 'legacy' };
      throw new Error('A typed page in the Local wiki is a file in the wiki folder; move it instead of removing its placement');

    default:
      throw new Error(`Unsupported Local wiki command: ${(command as { type?: string }).type}`);
  }
}
