/** Resolve Markdown embed paths within the host document's shared space. */

import { dirname } from 'pathe';
import { getEmbedFilePathCandidates } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/embedFilePaths';

import type { SharedDocument, SharedFolder } from '../../store/atoms/collabDocuments';
import type { CollaborativeEmbedReference } from '../../services/CollaborativeEmbedProviderCache';
import {
  getCollabNodeName,
  getSharedDocumentDisplayPath,
  UNRESOLVED_SHARED_DOCUMENT_NAME,
} from '../CollabMode/collabTree';

export interface SharedSpaceEmbedResolutionParams {
  /** The raw markdown link target, exactly as authored. */
  src: string;
  /** Org id of the host shared document; null when the host is not a shared doc. */
  hostOrgId: string | null;
  hostDocumentId?: string | null;
  documents: SharedDocument[];
  folders: SharedFolder[];
}

/** A shared-root-relative path. Filesystem URLs have no shared-space meaning. */
export function normalizeSharedSpaceLink(src: string): string | null {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
  return getEmbedFilePathCandidates(src, '/', '/')[0]?.replace(/^\//, '') || null;
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

  if (!normalizeSharedSpaceLink(params.src)) return null;
  const host = documents.find(document => document.documentId === params.hostDocumentId);
  const hostPath = host ? getSharedDocumentDisplayPath(host, folders) : null;
  const hostDir = hostPath && hostPath !== UNRESOLVED_SHARED_DOCUMENT_NAME ? dirname(`/${hostPath}`) : '/';
  const linkPaths = getEmbedFilePathCandidates(params.src, hostDir, '/');
  const linkPathKeys = linkPaths.map(path => path.replace(/^\//, '').toLowerCase());
  const linkName = getCollabNodeName(linkPathKeys[0]).toLowerCase();

  const exactMatches: SharedDocument[] = [];
  const nameMatches: SharedDocument[] = [];

  for (const document of documents) {
    if (!isResolvable(document)) continue;
    const displayPath = getSharedDocumentDisplayPath(document, folders);
    if (!displayPath || displayPath === UNRESOLVED_SHARED_DOCUMENT_NAME) continue;

    if (linkPathKeys.includes(displayPath.toLowerCase())) {
      exactMatches.push(document);
    } else if (getCollabNodeName(displayPath).toLowerCase() === linkName) {
      nameMatches.push(document);
    }
  }

  // Duplicate exact paths describe the same logical file, so pick
  // deterministically rather than failing the embed.
  const exact = exactMatches.sort((left, right) =>
    linkPathKeys.indexOf(getSharedDocumentDisplayPath(left, folders).toLowerCase())
      - linkPathKeys.indexOf(getSharedDocumentDisplayPath(right, folders).toLowerCase())
      || left.documentId.localeCompare(right.documentId),
  )[0];
  const explicitlyLocated = /^(?:\/|\.\.?\/)/.test(params.src);
  const resolved = exact ?? (!explicitlyLocated && nameMatches.length === 1 ? nameMatches[0] : undefined);
  if (!resolved) return null;

  return { documentId: resolved.documentId, orgId: hostOrgId };
}
