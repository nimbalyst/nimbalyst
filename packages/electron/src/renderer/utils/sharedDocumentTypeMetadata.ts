import type { SharedDocument } from '../store/atoms/collabDocuments';
import type {
  CollaborativeDocumentTypeCatalog,
  CollaborativeDocumentTypeDescriptor,
} from '../services/CollaborativeDocumentTypeCatalog';

export interface ResolvedSharedDocumentTypeMetadata {
  metadataVersion: 2;
  fileExtension?: string;
  editorId?: string;
  source: 'v2' | 'legacy-inferred';
}

export interface SharedDocumentTypePresentation {
  state: 'ready' | 'unsupported';
  icon: string;
  typeLabel: string;
  metadata: ResolvedSharedDocumentTypeMetadata;
  descriptor?: CollaborativeDocumentTypeDescriptor;
  reason?: string;
}

export const UNSUPPORTED_SHARED_DOCUMENT_ICON = 'lock';

function normalizeSuffix(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function fallbackSuffix(title: string, documentType: string): string | undefined {
  const lowerName = basename(title).toLowerCase();
  const documentTypeSuffix = normalizeSuffix(documentType);
  if (documentTypeSuffix && lowerName.endsWith(documentTypeSuffix)) return documentTypeSuffix;
  const dot = lowerName.lastIndexOf('.');
  return dot > 0 ? lowerName.slice(dot) : undefined;
}

/**
 * Normalize V2 metadata for reads, or infer it for a legacy index row. This is
 * deliberately pure: it never registers/backfills the row or touches a content
 * room.
 */
export function inferSharedDocumentTypeMetadata(
  document: Pick<
    SharedDocument,
    'title' | 'documentType' | 'metadataVersion' | 'fileExtension' | 'editorId'
  >,
  catalog: CollaborativeDocumentTypeCatalog,
): ResolvedSharedDocumentTypeMetadata {
  const source = document.metadataVersion === 2 ? 'v2' : 'legacy-inferred';
  const fileExtension = normalizeSuffix(document.fileExtension) ??
    catalog.inferFileExtension(document.documentType, document.title) ??
    fallbackSuffix(document.title, document.documentType);

  let editorId = document.editorId?.trim() || undefined;
  if (!editorId) {
    const resolved = catalog.resolveMetadata(document.documentType, fileExtension);
    if (resolved.descriptor) editorId = catalog.editorIdForDescriptor(resolved.descriptor);
  }

  return {
    metadataVersion: 2,
    fileExtension,
    editorId,
    source,
  };
}

export function resolveSharedDocumentTypePresentation(
  document: Pick<
    SharedDocument,
    | 'title'
    | 'documentType'
    | 'metadataVersion'
    | 'fileExtension'
    | 'editorId'
    | 'decryptFailed'
  >,
  catalog: CollaborativeDocumentTypeCatalog,
): SharedDocumentTypePresentation {
  const metadata = inferSharedDocumentTypeMetadata(document, catalog);
  if (document.decryptFailed) {
    return {
      state: 'unsupported',
      icon: UNSUPPORTED_SHARED_DOCUMENT_ICON,
      typeLabel: 'Locked document',
      metadata,
      reason: 'The shared document metadata is locked and cannot be resolved.',
    };
  }

  const resolution = catalog.resolveMetadata(
    document.documentType,
    metadata.fileExtension,
    metadata.editorId,
  );
  if (resolution.state === 'ready') {
    return {
      state: 'ready',
      icon: resolution.descriptor.icon,
      typeLabel: resolution.descriptor.displayName,
      metadata,
      descriptor: resolution.descriptor,
    };
  }

  return {
    state: 'unsupported',
    icon: UNSUPPORTED_SHARED_DOCUMENT_ICON,
    typeLabel: resolution.descriptor?.displayName ?? 'Unsupported document',
    metadata,
    descriptor: resolution.descriptor,
    reason: resolution.reason,
  };
}
