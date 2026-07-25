import {
  parseEmbedAttrs,
  serializeEmbedAttrs,
} from '@nimbalyst/runtime';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
} from 'pathe';

import { buildSharedDocumentDeepLink } from '../store/atoms/collabDocuments';
import type {
  CollaborativeDocumentTypeCatalog,
  CollaborativeDocumentTypeDescriptor,
} from './CollaborativeDocumentTypeCatalog';
import type {
  CreateCollaborativeDocumentInput,
} from './collaborativeDocumentCreationOrchestrator';

export interface SharedEmbeddedDocumentReference {
  documentId: string;
  orgId: string;
}

export interface EmbeddedDocumentCandidate {
  absolutePath: string;
  sourceHref: string;
  fileName: string;
  fileExtension: string;
  descriptor: CollaborativeDocumentTypeDescriptor;
  occurrences: number;
  alreadyShared?: SharedEmbeddedDocumentReference;
}

interface ParsedBlockLink {
  label: string;
  href: string;
  title: string;
  leading: string;
  trailing: string;
}

export interface DiscoverEmbeddedDocumentsInput {
  markdown: string;
  sourceFilePath: string;
  workspacePath: string;
  embeddableExtensions: readonly string[];
  catalog: Pick<CollaborativeDocumentTypeCatalog, 'resolveShareability'>;
  /**
   * Org the parent document is being shared into. A prior share into a
   * DIFFERENT org must not be reused: the rewritten deep link carries the
   * org, so recipients of this share would resolve it against their own org
   * and see "belongs to a different team". Such a binding is ignored and the
   * file is shared again into `expectedOrgId`.
   */
  expectedOrgId: string | null;
  fileExists(absolutePath: string): Promise<boolean>;
  findExisting(absolutePath: string): Promise<SharedEmbeddedDocumentReference | null>;
}

export interface RewriteEmbeddedDocumentLinksInput {
  markdown: string;
  sourceFilePath: string;
  workspacePath: string;
  candidates: readonly EmbeddedDocumentCandidate[];
  sharedReferences: ReadonlyMap<string, SharedEmbeddedDocumentReference>;
}

export interface ShareEmbeddedDocumentsInput {
  candidates: readonly EmbeddedDocumentCandidate[];
  selectedPaths: ReadonlySet<string>;
  parentFolderId: string | null;
  readSourceContent(
    candidate: EmbeddedDocumentCandidate,
  ): Promise<string | Uint8Array>;
  createDocument(
    input: CreateCollaborativeDocumentInput,
  ): Promise<{ documentId: string; title: string }>;
  generateId(): string;
  resolveOrgId(): Promise<string>;
}

export interface EmbeddedDocumentShareFailure {
  absolutePath: string;
  fileName: string;
  error: string;
}

export interface ShareEmbeddedDocumentsResult {
  sharedReferences: Map<string, SharedEmbeddedDocumentReference>;
  /**
   * Ids of documents this call actually created, in creation order. Callers
   * roll these back when a later step (the parent document) fails; the
   * `alreadyShared` reuses are deliberately absent -- they predate this call.
   */
  createdDocumentIds: string[];
  failures: EmbeddedDocumentShareFailure[];
}

const BLOCK_LINK_PATTERN =
  /^(\s*)\[([^\]]+)\]\((<[^>]+>|[^\s)]+)(?:\s+"([^"]*)")?\)(\s*)$/;

const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;

function parseBlockLink(line: string): ParsedBlockLink | null {
  const match = BLOCK_LINK_PATTERN.exec(line);
  if (!match) return null;
  const rawHref = match[3];
  return {
    leading: match[1],
    label: match[2],
    href: rawHref.startsWith('<') && rawHref.endsWith('>')
      ? rawHref.slice(1, -1)
      : rawHref,
    title: match[4] ?? '',
    trailing: match[5],
  };
}

/**
 * Walk the block-isolated links of a markdown document, skipping fenced code
 * blocks. A link alone on a line inside a fence is documentation, not an
 * embed -- Lexical never renders it as one, and rewriting it would corrupt
 * the example.
 *
 * `parts` is the `split(/(\r?\n)/)` form so a caller can mutate content lines
 * in place and rejoin without touching line endings.
 */
function forEachBlockLink(
  parts: readonly string[],
  visit: (link: ParsedBlockLink, index: number) => void,
): void {
  let openFence: string | null = null;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const fence = FENCE_PATTERN.exec(line)?.[1];
    if (openFence) {
      // A closing fence must be at least as long and use the same character.
      if (fence && fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = null;
      }
      continue;
    }
    if (fence) {
      openFence = fence;
      continue;
    }
    const link = parseBlockLink(line);
    if (link) visit(link, index);
  }
}

function normalizeExtension(extension: string): string {
  const lower = extension.trim().toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

function matchingEmbeddableExtension(
  href: string,
  extensions: readonly string[],
): string | null {
  const pathPart = href.split('?')[0].split('#')[0].toLowerCase();
  return extensions
    .map(normalizeExtension)
    .sort((left, right) => right.length - left.length)
    .find(extension => pathPart.endsWith(extension))
    ?? null;
}

export function resolveEmbeddedDocumentPath(
  href: string,
  sourceFilePath: string,
  workspacePath: string,
): string | null {
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
    return null;
  }

  const withoutQuery = href.split('?')[0].split('#')[0];
  let decoded = withoutQuery.replace(/^file:\/\//i, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  if (isAbsolute(decoded)) return normalize(decoded);
  if (decoded.startsWith('./') || decoded.startsWith('../')) {
    return normalize(join(dirname(sourceFilePath), decoded));
  }
  return normalize(join(workspacePath, decoded));
}

export async function discoverEmbeddedDocuments(
  input: DiscoverEmbeddedDocumentsInput,
): Promise<EmbeddedDocumentCandidate[]> {
  const candidates = new Map<string, EmbeddedDocumentCandidate>();
  const parts = input.markdown.split(/(\r?\n)/);

  // Collect first (the walk is synchronous), then resolve. Occurrence counts
  // have to be complete before the async work so a repeated embed is only
  // probed and shared once.
  const sites: { link: ParsedBlockLink; fileExtension: string; absolutePath: string }[] = [];
  forEachBlockLink(parts, link => {
    const fileExtension = matchingEmbeddableExtension(
      link.href,
      input.embeddableExtensions,
    );
    if (!fileExtension) return;
    const absolutePath = resolveEmbeddedDocumentPath(
      link.href,
      input.sourceFilePath,
      input.workspacePath,
    );
    if (!absolutePath) return;
    sites.push({ link, fileExtension, absolutePath });
  });

  for (const { link, fileExtension, absolutePath } of sites) {
    const existing = candidates.get(absolutePath);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }

    if (!(await input.fileExists(absolutePath))) continue;
    const fileName = basename(absolutePath);
    const shareability = input.catalog.resolveShareability(fileName);
    if (
      shareability.state !== 'ready'
      || shareability.descriptor.editor.kind !== 'extension'
    ) {
      continue;
    }
    const binding = await input.findExisting(absolutePath);
    const alreadyShared = binding && binding.orgId === input.expectedOrgId
      ? binding
      : null;
    candidates.set(absolutePath, {
      absolutePath,
      sourceHref: link.href,
      fileName,
      fileExtension,
      descriptor: shareability.descriptor,
      occurrences: 1,
      ...(alreadyShared ? { alreadyShared } : {}),
    });
  }

  return [...candidates.values()];
}

function withEmbedType(title: string, fileExtension: string): string {
  const attrs = parseEmbedAttrs(title);
  attrs.embedType = fileExtension;
  delete attrs.embed;
  return serializeEmbedAttrs(attrs);
}

export function rewriteEmbeddedDocumentLinks(
  input: RewriteEmbeddedDocumentLinksInput,
): string {
  const candidatesByPath = new Map(
    input.candidates.map(candidate => [candidate.absolutePath, candidate]),
  );
  const parts = input.markdown.split(/(\r?\n)/);

  forEachBlockLink(parts, (link, index) => {
    const absolutePath = resolveEmbeddedDocumentPath(
      link.href,
      input.sourceFilePath,
      input.workspacePath,
    );
    if (!absolutePath) return;
    const candidate = candidatesByPath.get(absolutePath);
    const reference = input.sharedReferences.get(absolutePath);
    if (!candidate || !reference) return;

    const deepLink = buildSharedDocumentDeepLink(
      reference.documentId,
      reference.orgId,
    );
    const title = withEmbedType(link.title, candidate.fileExtension);
    parts[index] = `${link.leading}[${link.label}](${deepLink} "${title}")${link.trailing}`;
  });

  return parts.join('');
}

export async function shareEmbeddedDocuments(
  input: ShareEmbeddedDocumentsInput,
): Promise<ShareEmbeddedDocumentsResult> {
  const sharedReferences = new Map<string, SharedEmbeddedDocumentReference>();
  const createdDocumentIds: string[] = [];
  const failures: EmbeddedDocumentShareFailure[] = [];
  let orgId: string | null = null;
  const getOrgId = async () => {
    orgId ??= await input.resolveOrgId();
    return orgId;
  };

  for (const candidate of input.candidates) {
    if (!input.selectedPaths.has(candidate.absolutePath)) continue;
    if (candidate.alreadyShared) {
      sharedReferences.set(candidate.absolutePath, candidate.alreadyShared);
      continue;
    }

    try {
      const sourceContent = await input.readSourceContent(candidate);
      const documentId = input.generateId();
      const document = await input.createDocument({
        descriptor: candidate.descriptor,
        requestedName: candidate.fileName,
        parentFolderId: input.parentFolderId,
        sourceContent,
        localOrigin: {
          sourceFilePath: candidate.absolutePath,
          sourceContent,
        },
        operationId: documentId,
        documentId,
        openAfterCreate: false,
      });
      createdDocumentIds.push(document.documentId);
      sharedReferences.set(candidate.absolutePath, {
        documentId: document.documentId,
        orgId: await getOrgId(),
      });
    } catch (error) {
      failures.push({
        absolutePath: candidate.absolutePath,
        fileName: candidate.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { sharedReferences, createdDocumentIds, failures };
}
