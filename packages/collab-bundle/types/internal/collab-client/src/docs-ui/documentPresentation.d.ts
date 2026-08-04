import type { CollabDocumentTypeDescriptor } from '../core/index';
import type { SharedDocument } from '../docs/index';
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
export declare const UNSUPPORTED_SHARED_DOCUMENT_ICON = "lock";
export declare function inferSharedDocumentTypeMetadata(document: Pick<SharedDocument, 'title' | 'documentType' | 'metadataVersion' | 'fileExtension' | 'editorId'>, descriptors: readonly CollabDocumentTypeDescriptor[]): ResolvedSharedDocumentTypeMetadata;
export declare function resolveSharedDocumentTypePresentation(document: Pick<SharedDocument, 'title' | 'documentType' | 'metadataVersion' | 'fileExtension' | 'editorId' | 'decryptFailed'>, descriptors: readonly CollabDocumentTypeDescriptor[]): SharedDocumentTypePresentation;
