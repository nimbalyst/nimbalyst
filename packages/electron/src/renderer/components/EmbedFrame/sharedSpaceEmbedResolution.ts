/**
 * Shared-space resolution for embedded-file links.
 *
 * A markdown embed inside a LOCAL document names its target with a path
 * relative to the workspace root (`nimbalyst-local/mockups/foo.mockup.html`).
 * When the same prose lives in a SHARED document there is no workspace root to
 * resolve against -- the sibling files are shared documents in the team's
 * collab space, not files on this machine's disk. Historically `EmbedFrame`
 * resolved every non-`nimbalyst://doc` link against `window.__workspacePath`,
 * so those embeds rendered "File not found" even though the document was
 * sitting right there in the collab file tree (NIM-2271).
 *
 * This module maps such a link onto a shared document so the caller can route
 * it through the existing collaborative-embed path. Resolution is deliberately
 * conservative: when nothing matches we return null and the caller falls back
 * to the filesystem behaviour it has always had.
 */

import { isAbsolute } from 'pathe';

import type { SharedDocument, SharedFolder } from '../../store/atoms/collabDocuments';
import type { CollaborativeEmbedReference } from '../../services/CollaborativeEmbedProviderCache';
import {
  getCollabNodeName,
  getSharedDocumentDisplayPath,
  normalizeCollabPath,
  UNRESOLVED_SHARED_DOCUMENT_NAME,
} from '../CollabMode/collabTree';

export interface SharedSpaceEmbedResolutionParams {
  /** The raw markdown link target, exactly as authored. */
  src: string;
  /** Org id of the host shared document; null when the host is not a shared doc. */
  hostOrgId: string | null;
  documents: SharedDocument[];
  folders: SharedFolder[];
}

/**
 * Normalize a link target into a collab-space path, or null when the link is
 * not a relative path we can resolve in the shared space (absolute paths,
 * protocol URLs, and empty strings all bail).
 *
 * Leading `./` segments are dropped -- inside a shared document "the host doc's
 * directory" and "the shared space root" are the same place, so `./foo` and
 * `foo` name the same thing.
 */
export function normalizeSharedSpaceLink(src: string): string | null {
  if (!src) return null;
  // Any protocol-qualified URL (http://, nimbalyst://, file://, mailto:) is
  // handled elsewhere -- never a shared-space path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  if (isAbsolute(src)) return null;

  const segments = normalizeCollabPath(src).split('/').filter(Boolean);
  while (segments.length > 0 && segments[0] === '.') segments.shift();
  if (segments.length === 0) return null;
  // `../` has no meaning in a flat shared space; refuse to guess.
  if (segments.some(segment => segment === '..')) return null;

  return segments.join('/');
}

function isResolvable(document: SharedDocument): boolean {
  return !document.trashedAt && !document.decryptFailed;
}

/**
 * Resolve a relative embed link against the team's shared documents.
 *
 * Two tiers, most specific first:
 *   1. Exact display-path match -- covers docs shared from a local file, whose
 *      title still carries the full `nimbalyst-local/mockups/x.html` path, and
 *      docs filed into first-class folders mirroring that path.
 *   2. Unique basename match -- covers a doc that was moved or renamed into a
 *      different shared folder after the prose was written. Ambiguous
 *      basenames resolve to null rather than picking an arbitrary document.
 */
export function resolveSharedSpaceEmbedReference(
  params: SharedSpaceEmbedResolutionParams,
): CollaborativeEmbedReference | null {
  const { hostOrgId, documents, folders } = params;
  if (!hostOrgId) return null;

  const linkPath = normalizeSharedSpaceLink(params.src);
  if (!linkPath) return null;
  const linkPathKey = linkPath.toLowerCase();
  const linkName = getCollabNodeName(linkPath).toLowerCase();

  const exactMatches: SharedDocument[] = [];
  const nameMatches: SharedDocument[] = [];

  for (const document of documents) {
    if (!isResolvable(document)) continue;
    const displayPath = getSharedDocumentDisplayPath(document, folders);
    if (!displayPath || displayPath === UNRESOLVED_SHARED_DOCUMENT_NAME) continue;

    if (displayPath.toLowerCase() === linkPathKey) {
      exactMatches.push(document);
    } else if (getCollabNodeName(displayPath).toLowerCase() === linkName) {
      nameMatches.push(document);
    }
  }

  // Duplicate exact paths describe the same logical file, so pick
  // deterministically rather than failing the embed.
  const exact = exactMatches.sort((left, right) =>
    left.documentId.localeCompare(right.documentId),
  )[0];
  const resolved = exact ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);
  if (!resolved) return null;

  return { documentId: resolved.documentId, orgId: hostOrgId };
}
