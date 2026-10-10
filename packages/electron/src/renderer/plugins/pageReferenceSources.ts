/**
 * What the `@` typeahead offers, by where the editor is:
 *
 *   a Team page (`collab://`)          Team pages
 *   a Personal page (`personal-doc://`) Personal pages
 *   a local file                       local files, then Team and Personal pages
 *
 * A link only means something where its reader can open it, so a page links
 * within its own section; a local file is the author's own and may link to
 * either. A Personal page is linked by its console link (`/app/page/<id>`),
 * which only this desktop opens; with its type as `embedType` an extension
 * page embeds (`PersonalPageEmbedFrame`).
 */

import { buildConsoleLink, parseConsoleLink } from '@nimbalyst/collab-protocol';
import { getSharedDocumentDisplayName, pageDisplayName } from '@nimbalyst/collab-client/docs';
import type { CollabReferenceOption, CollabReferenceSource } from '@nimbalyst/runtime/plugins/DocumentLinkPlugin';
import { isCollabReferenceHref } from '@nimbalyst/runtime/plugins/DocumentLinkPlugin/documentLinkPaths';
import type { SharedDocument, SharedFolder } from '../store/atoms/collabDocuments';
import { getCollaborativeDocumentTypeCatalog } from '../services/CollaborativeDocumentTypeCatalog';
import { PERSONAL_PAGE_HISTORY_PREFIX } from '../../shared/personalPageUri';

/** Where the editor's document lives, which decides what `@` offers. */
export type ReferenceContext = 'team' | 'personal' | 'local' | 'other';

export function referenceContextOf(documentPath: string | null): ReferenceContext {
  if (!documentPath) return 'other';
  if (documentPath.startsWith('collab://')) return 'team';
  if (documentPath.startsWith(PERSONAL_PAGE_HISTORY_PREFIX)) return 'personal';
  // Any other scheme (virtual://, tracker bodies...) is not a file of this workspace.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(documentPath) ? 'other' : 'local';
}

/** The Personal page an editor path is the body of, or null (a typed page's body, or not Personal). */
export function personalPageIdOf(documentPath: string): string | null {
  if (!documentPath.startsWith(PERSONAL_PAGE_HISTORY_PREFIX)) return null;
  const id = documentPath.slice(PERSONAL_PAGE_HISTORY_PREFIX.length);
  return id && !id.includes('/') ? id : null;
}

export function personalPageLink(documentId: string): string {
  return buildConsoleLink({ kind: 'page', scope: 'local', pageId: documentId });
}

export function isPersonalPageLink(href: string): boolean {
  const target = parseConsoleLink(href);
  return target?.kind === 'page' && target.scope === 'local';
}

/**
 * Resolve each folderId to its full breadcrumb ("Design/Specs") from the
 * first-class folder tree, so shared-doc suggestions can show where the doc
 * lives. Guards against cycles.
 */
export function buildFolderBreadcrumbs(folders: SharedFolder[]): Map<string, string> {
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
export function sharedDocumentFileExtension(doc: SharedDocument): string | undefined {
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

export function teamPageReferenceOptions(input: {
  documents: SharedDocument[];
  folders: SharedFolder[];
  deepLink: (documentId: string) => string;
  currentDocumentId?: string;
  pathPrefix?: string;
}): CollabReferenceOption[] {
  const breadcrumbs = buildFolderBreadcrumbs(input.folders);
  return input.documents
    .filter((doc) => !doc.decryptFailed && doc.documentId !== input.currentDocumentId)
    .map((doc) => ({
      documentId: doc.documentId,
      title: doc.title || 'Untitled',
      target: input.deepLink(doc.documentId),
      folderPath: withPrefix(input.pathPrefix, doc.parentFolderId ? breadcrumbs.get(doc.parentFolderId) : undefined),
      // Lets the plugin insert a shared mockup/diagram as a live embed
      // rather than a plain reference.
      embedType: sharedDocumentFileExtension(doc),
    }));
}

/** Personal pages as `@` options; nested pages show their parent pages as the path. */
export function personalPageReferenceOptions(input: {
  documents: SharedDocument[];
  currentDocumentId?: string | null;
  pathPrefix?: string;
}): CollabReferenceOption[] {
  const byId = new Map(input.documents.map((doc) => [doc.documentId, doc]));
  const titleOf = (doc: SharedDocument) => pageDisplayName(getSharedDocumentDisplayName(doc.title, doc.documentId), doc.documentType);
  const parentPath = (doc: SharedDocument): string | undefined => {
    const names: string[] = [];
    const seen = new Set<string>([doc.documentId]);
    let parentId = doc.parentKind === 'item' ? null : doc.parentFolderId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      names.unshift(titleOf(parent));
      parentId = parent.parentKind === 'item' ? null : parent.parentFolderId;
    }
    return names.length > 0 ? names.join('/') : undefined;
  };
  return input.documents
    .filter((doc) => doc.documentId !== input.currentDocumentId)
    .map((doc) => ({
      documentId: doc.documentId,
      title: titleOf(doc),
      target: personalPageLink(doc.documentId),
      folderPath: withPrefix(input.pathPrefix, parentPath(doc)),
      // A drawing or other extension page embeds, as a Team one does.
      embedType: sharedDocumentFileExtension(doc),
      icon: 'person',
    }));
}

function withPrefix(prefix: string | undefined, path: string | undefined): string | undefined {
  if (!prefix) return path || undefined;
  return path ? `${prefix}/${path}` : prefix;
}

/**
 * A local file's `@`: its workspace files, after the Team and Personal pages.
 * Clicking a Team reference opens it like a Team page's would; a Personal
 * one opens through its console link. `wikiPageFor` names the Local wiki page
 * a file link points at, so a link between wiki pages shown in Pages opens
 * the page there instead of the file in Files.
 */
export function localFileReferenceSource(input: {
  listTeam: () => CollabReferenceOption[];
  listPersonal: () => CollabReferenceOption[];
  openTeam: CollabReferenceSource['openReference'];
  openPersonal: CollabReferenceSource['openReference'];
  wikiPageFor?: (target: string) => string | null;
}): CollabReferenceSource {
  const wikiPageFor = (target: string) => input.wikiPageFor?.(target) ?? null;
  return {
    includeLocalFiles: true,
    listOptions: () => [...input.listTeam(), ...input.listPersonal()],
    ownsTarget: (target) => isCollabReferenceHref(target) || isPersonalPageLink(target) || wikiPageFor(target) !== null,
    openReference: (target, options) => {
      if (isPersonalPageLink(target)) return input.openPersonal(target, options);
      if (isCollabReferenceHref(target)) return input.openTeam(target, options);
      const wikiPageId = wikiPageFor(target);
      if (wikiPageId) input.openPersonal(personalPageLink(wikiPageId), options);
    },
  };
}
