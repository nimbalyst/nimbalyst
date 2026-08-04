import type { CollabDocumentTypeDescriptor } from '@nimbalyst/collab-client/core';
import type { SharedDocument } from '@nimbalyst/collab-client/docs';

export interface SharedDocumentTypePresentation {
  state: 'ready' | 'unsupported';
  icon: string;
  typeLabel: string;
  metadata: ResolvedSharedDocumentTypeMetadata;
  descriptor?: CollabDocumentTypeDescriptor;
  reason?: string;
}

export interface ResolvedSharedDocumentTypeMetadata {
  metadataVersion: 2;
  fileExtension?: string;
  editorId?: string;
  source: 'v2' | 'legacy-inferred';
}

export const UNSUPPORTED_SHARED_DOCUMENT_ICON = 'lock';

function normalizeSuffix(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function titleSuffix(
  title: string,
  documentType: string,
  descriptors: readonly CollabDocumentTypeDescriptor[],
): string | undefined {
  const basename = title.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
  const knownSuffix = descriptors
    .filter((descriptor) => descriptor.documentType === documentType)
    .flatMap((descriptor) => descriptor.fileExtensions)
    .map(normalizeSuffix)
    .filter((suffix): suffix is string => suffix !== undefined)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .find((suffix) => basename.endsWith(suffix));
  if (knownSuffix) return knownSuffix;

  const documentTypeSuffix = normalizeSuffix(documentType);
  if (documentTypeSuffix && basename.endsWith(documentTypeSuffix)) return documentTypeSuffix;
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot) : undefined;
}

function editorIdForDescriptor(descriptor: CollabDocumentTypeDescriptor): string {
  if (descriptor.editor.kind === 'lexical') return 'builtin.lexical';
  if (descriptor.editor.kind === 'monaco') return 'builtin.monaco';
  return descriptor.editor.extensionId ?? 'unavailable';
}

export function inferSharedDocumentTypeMetadata(
  document: Pick<SharedDocument, 'title' | 'documentType' | 'metadataVersion' | 'fileExtension' | 'editorId'>,
  descriptors: readonly CollabDocumentTypeDescriptor[],
): ResolvedSharedDocumentTypeMetadata {
  const source = document.metadataVersion === 2 ? 'v2' : 'legacy-inferred';
  const fileExtension = normalizeSuffix(document.fileExtension)
    ?? titleSuffix(document.title, document.documentType, descriptors);
  const descriptor = descriptors.find((candidate) => (
    candidate.documentType === document.documentType
    && (!fileExtension || candidate.fileExtensions.some(
      (value) => normalizeSuffix(value) === fileExtension,
    ))
  ));
  return {
    metadataVersion: 2,
    fileExtension,
    editorId: document.editorId?.trim() || (descriptor ? editorIdForDescriptor(descriptor) : undefined),
    source,
  };
}

export function resolveSharedDocumentTypePresentation(
  document: Pick<SharedDocument, 'title' | 'documentType' | 'metadataVersion' | 'fileExtension' | 'editorId' | 'decryptFailed'>,
  descriptors: readonly CollabDocumentTypeDescriptor[],
): SharedDocumentTypePresentation {
  const metadata = inferSharedDocumentTypeMetadata(document, descriptors);
  if (document.decryptFailed) {
    return {
      state: 'unsupported',
      icon: UNSUPPORTED_SHARED_DOCUMENT_ICON,
      typeLabel: 'Locked document',
      metadata,
      reason: 'The shared document metadata is locked and cannot be resolved.',
    };
  }

  const descriptor = descriptors.find((candidate) => {
    if (candidate.documentType !== document.documentType) return false;
    if (metadata.editorId && editorIdForDescriptor(candidate) !== metadata.editorId) {
      return false;
    }
    return !metadata.fileExtension || candidate.fileExtensions.some(
      (value) => normalizeSuffix(value) === metadata.fileExtension,
    );
  });

  if (descriptor && !descriptor.capabilities.disabledReason) {
    return {
      state: 'ready',
      icon: descriptor.icon,
      typeLabel: descriptor.displayName,
      metadata,
      descriptor,
    };
  }
  return {
    state: 'unsupported',
    icon: UNSUPPORTED_SHARED_DOCUMENT_ICON,
    typeLabel: descriptor?.displayName ?? 'Unsupported document',
    metadata,
    descriptor,
    reason: descriptor?.capabilities.disabledReason
      ?? 'No host document type can open this shared document.',
  };
}
