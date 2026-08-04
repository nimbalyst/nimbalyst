import { store } from '@nimbalyst/runtime/store';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import type { CollabDocumentConfig } from '../utils/collabDocumentOpener';
import {
  removeCollabConfigsForDocument,
  resolveCollabConfigForUri,
} from '../utils/collabDocumentOpener';
import { seedSharedDocument } from '../utils/documentSeedOrchestrator';
import {
  getCollabNodeName,
  getSharedDocumentDisplayPath,
  joinCollabPath,
  normalizeCollabPath,
} from '../components/CollabMode/collabTree';
import {
  pendingCollabDocumentAtom,
  getSharedDocumentsForScope,
  getSharedFoldersForScope,
  registerDocumentInIndex,
  type SharedDocument,
  type SharedFolder,
} from '../store/atoms/collabDocuments';
import { setWindowModeAtom } from '../store/atoms/windowMode';
import {
  getCollaborativeDocumentTypeCatalog,
  normalizeSuffix,
  type CollaborativeDocumentTypeCatalog,
  type CollaborativeDocumentTypeDescriptor,
} from './CollaborativeDocumentTypeCatalog';
import { logger } from '../utils/logger';
import {
  bucketItemCount,
  categorizeTeamAnalyticsError,
  toStableAnalyticsCategory,
} from '../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../utils/teamAnalytics';
import type { CollabDocumentOpenSource } from '../utils/collabDocumentOpener';

export interface CollaborativeDocumentLocalOrigin {
  sourceFilePath: string;
  /** Original local bytes when a pre-seed transform changed sourceContent. */
  sourceContent?: string | Uint8Array;
}

export interface CreateCollaborativeDocumentInput {
  scope: CollabScope;
  descriptor: CollaborativeDocumentTypeDescriptor;
  requestedName: string;
  parentFolderId: string | null;
  sourceContent?: string | Uint8Array;
  localOrigin?: string | CollaborativeDocumentLocalOrigin;
  /** Optional stable retry key. Defaults to the generated document id. */
  operationId?: string;
  /** Optional preallocated id for pre-seed hooks such as markdown asset migration. */
  documentId?: string;
  /** Whether creation should navigate to/open this document. Defaults to true. */
  openAfterCreate?: boolean;
  /** Required at production call sites; defaults preserve older tests and retries. */
  analyticsSource?: 'new_document' | 'share_to_team' | 'agent_tool' | 'embedded_document';
  analyticsActorType?: 'user' | 'agent';
  analyticsLinkedDocumentCount?: number;
  analyticsAssetMigrationOutcome?: 'not_needed' | 'success' | 'partial' | 'failed';
}

export type CollaborativeDocumentCreationErrorCode =
  | 'invalid-descriptor'
  | 'invalid-name'
  | 'invalid-parent-folder'
  | 'name-collision'
  | 'workspace-unavailable'
  | 'config-unavailable'
  | 'seed-failed'
  | 'register-failed'
  | 'local-origin-failed'
  | 'operation-conflict';

export class CollaborativeDocumentCreationError extends Error {
  constructor(
    public readonly code: CollaborativeDocumentCreationErrorCode,
    message: string,
    public readonly operationId: string,
    public readonly documentId: string,
    public readonly announced: boolean,
    options?: { cause?: unknown },
  ) {
    super(message);
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    this.name = 'CollaborativeDocumentCreationError';
  }
}

interface FrozenOperation {
  operationId: string;
  documentId: string;
  fingerprint: string;
  result?: SharedDocument;
  inFlight?: Promise<SharedDocument>;
  resolvedType?: {
    descriptor: CollaborativeDocumentTypeDescriptor;
    name: string;
    metadata: { metadataVersion: 2; fileExtension: string; editorId: string };
  };
}

export interface CollaborativeDocumentCreationDependencies {
  getCatalog(): CollaborativeDocumentTypeCatalog;
  getDocuments(scope: CollabScope): SharedDocument[];
  getFolders(scope: CollabScope): SharedFolder[];
  resolveConfig(
    scope: CollabScope,
    uri: string,
    documentId: string,
    title: string,
    documentType: string,
    metadata: { metadataVersion: 2; fileExtension: string; editorId: string },
  ): Promise<CollabDocumentConfig | null>;
  seed(params: {
    workspacePath: string;
    documentId: string;
    documentType: string;
    title: string;
    content: string | Uint8Array;
  }): Promise<{ ok: boolean; error?: string }>;
  register(
    scope: CollabScope,
    documentId: string,
    title: string,
    documentType: string,
    parentFolderId: string | null,
    metadata: { metadataVersion: 2; fileExtension: string; editorId: string },
  ): Promise<void>;
  saveLocalOrigin?(payload: {
    workspacePath: string;
    documentId: string;
    documentType: string;
    sourceFilePath: string;
    lastLocalContentHash: string | null;
    lastCollabContentHash: string | null;
  }): Promise<{ success: boolean; error?: string }>;
  publishPending(
    scope: CollabScope,
    document: SharedDocument,
    initialContent?: string,
    source?: CollabDocumentOpenSource,
  ): void;
  cleanup(scope: CollabScope, documentId: string): Promise<void>;
  generateId(): string;
  now(): number;
  hashContent(content: string | Uint8Array): Promise<string>;
}

function cloneDescriptor(
  descriptor: CollaborativeDocumentTypeDescriptor,
): CollaborativeDocumentTypeDescriptor {
  return {
    ...descriptor,
    fileExtensions: [...descriptor.fileExtensions],
    editor: { ...descriptor.editor },
    content: { ...descriptor.content },
    creation: descriptor.creation
      ? {
          ...descriptor.creation,
          defaultContent: descriptor.creation.defaultContent instanceof Uint8Array
            ? descriptor.creation.defaultContent.slice()
            : descriptor.creation.defaultContent,
        }
      : undefined,
    capabilities: { ...descriptor.capabilities },
  };
}

function normalizeNameAndSuffix(
  requestedName: string,
  descriptor: CollaborativeDocumentTypeDescriptor,
): { name: string; fileExtension: string } | null {
  const leaf = getCollabNodeName(requestedName).trim();
  if (!leaf || leaf === '.' || leaf === '..') return null;

  const suffixes = descriptor.fileExtensions
    .map(normalizeSuffix)
    .filter((suffix): suffix is string => suffix !== null)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const defaultExtension = normalizeSuffix(descriptor.defaultExtension);
  if (!defaultExtension || !suffixes.includes(defaultExtension)) return null;

  const lower = leaf.toLowerCase();
  const matched = suffixes.find(suffix => lower.endsWith(suffix));
  if (!matched) return { name: `${leaf}${defaultExtension}`, fileExtension: defaultExtension };

  return {
    name: `${leaf.slice(0, leaf.length - matched.length)}${matched}`,
    fileExtension: matched,
  };
}

function folderPathForId(folders: SharedFolder[], folderId: string | null): string | null {
  if (!folderId) return '';
  const byId = new Map(folders.map(folder => [folder.folderId, folder]));
  if (!byId.has(folderId)) return null;
  const segments: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.folderId)) {
    seen.add(current.folderId);
    if (current.name.trim()) segments.unshift(current.name.trim());
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return normalizeCollabPath(segments.join('/'));
}

function operationFingerprint(input: CreateCollaborativeDocumentInput): string {
  const fingerprintContent = (content: string | Uint8Array | undefined): string => {
    if (content === undefined) return 'undefined';
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    return `${bytes.byteLength}:${(hash >>> 0).toString(16)}`;
  };
  const localPath = typeof input.localOrigin === 'string'
    ? input.localOrigin
    : input.localOrigin?.sourceFilePath ?? '';
  const localContent = typeof input.localOrigin === 'string'
    ? undefined
    : input.localOrigin?.sourceContent;
  return JSON.stringify([
    input.scope.scopeKey,
    input.scope.orgId,
    input.descriptor.documentType,
    input.descriptor.defaultExtension,
    input.descriptor.fileExtensions,
    input.descriptor.editor.extensionId ?? input.descriptor.editor.kind,
    input.descriptor.editor.componentName ?? '',
    input.requestedName.trim(),
    input.parentFolderId,
    fingerprintContent(input.sourceContent),
    localPath,
    fingerprintContent(localContent),
  ]);
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
}

async function sha256Hex(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function defaultDependencies(): CollaborativeDocumentCreationDependencies {
  return {
    getCatalog: getCollaborativeDocumentTypeCatalog,
    getDocuments: getSharedDocumentsForScope,
    getFolders: getSharedFoldersForScope,
    resolveConfig: (scope, uri, documentId, title, documentType, metadata) =>
      resolveCollabConfigForUri(
        scope,
        uri,
        documentId,
        title,
        documentType,
        { metadata },
      ),
    seed: seedSharedDocument,
    register: registerDocumentInIndex,
    saveLocalOrigin: async payload => {
      const save = window.electronAPI?.documentSync?.saveLocalOrigin;
      if (!save) return { success: false, error: 'Local-origin persistence is unavailable.' };
      return save(payload);
    },
    publishPending: (scope, document, initialContent, source) => {
      store.set(pendingCollabDocumentAtom, {
        scopeKey: scope.scopeKey,
        orgId: scope.orgId,
        documentId: document.documentId,
        documentType: document.documentType,
        metadataVersion: document.metadataVersion,
        fileExtension: document.fileExtension,
        editorId: document.editorId,
        initialContent,
        analyticsSource: source,
      });
      store.set(setWindowModeAtom, 'collab');
    },
    cleanup: async (scope, documentId) => {
      removeCollabConfigsForDocument(scope, documentId);
      await window.electronAPI?.documentSync?.closeDoc?.(documentId).catch(() => undefined);
    },
    generateId: () => crypto.randomUUID(),
    now: () => Date.now(),
    hashContent: sha256Hex,
  };
}

/**
 * The single create/promotion pipeline for shared documents. It resolves a
 * live catalog descriptor, seeds before announcement, writes V2 metadata, and
 * opens through CollabMode's pending-document path.
 */
export class CollaborativeDocumentCreationOrchestrator {
  private readonly operations = new Map<string, FrozenOperation>();

  constructor(private readonly dependencies: CollaborativeDocumentCreationDependencies = defaultDependencies()) {}

  async create(input: CreateCollaborativeDocumentInput): Promise<SharedDocument> {
    const existingOperation = input.operationId ? this.operations.get(input.operationId) : undefined;
    const documentId = existingOperation?.documentId ?? input.documentId ?? this.dependencies.generateId();
    const operationId = input.operationId ?? documentId;
    const fingerprint = operationFingerprint(input);
    const operation = this.operations.get(operationId);

    if (operation && operation.fingerprint !== fingerprint) {
      throw new CollaborativeDocumentCreationError(
        'operation-conflict',
        `Collaborative creation operation "${operationId}" was retried with different inputs.`,
        operationId,
        operation.documentId,
        !!operation.result,
      );
    }
    if (operation?.result) return operation.result;
    if (operation?.inFlight) return operation.inFlight;

    const record = operation ?? { operationId, documentId, fingerprint };
    this.operations.set(operationId, record);
    const promise = this.perform(input, record);
    record.inFlight = promise;
    try {
      const result = await promise;
      record.result = result;
      return result;
    } finally {
      record.inFlight = undefined;
    }
  }

  private async perform(
    input: CreateCollaborativeDocumentInput,
    operation: FrozenOperation,
  ): Promise<SharedDocument> {
    const { operationId, documentId } = operation;
    let announced = false;
    const { scope } = input;
    let configResolved = false;
    try {
      if (!operation.resolvedType) {
        const catalog = this.dependencies.getCatalog();
        const normalized = normalizeNameAndSuffix(input.requestedName, input.descriptor);
        if (!normalized) {
          throw new CollaborativeDocumentCreationError(
            'invalid-name',
            'A shared document needs a valid name and catalog suffix.',
            operationId,
            documentId,
            false,
          );
        }

        const requestedEditorId = catalog.editorIdForDescriptor(input.descriptor);
        const liveResolution = catalog.resolveMetadata(
          input.descriptor.documentType,
          normalized.fileExtension,
          requestedEditorId,
        );
        if (liveResolution.state !== 'ready') {
          throw new CollaborativeDocumentCreationError(
            'invalid-descriptor',
            liveResolution.reason,
            operationId,
            documentId,
            false,
          );
        }
        const descriptor = cloneDescriptor(liveResolution.descriptor);
        operation.resolvedType = {
          descriptor,
          name: normalized.name,
          metadata: {
            metadataVersion: 2,
            fileExtension: normalized.fileExtension,
            editorId: catalog.editorIdForDescriptor(descriptor),
          },
        };
      }
      const { descriptor, name, metadata } = operation.resolvedType;

      const documents = this.dependencies.getDocuments(scope);
      const folders = this.dependencies.getFolders(scope);
      const parentPath = folderPathForId(folders, input.parentFolderId);
      if (parentPath === null) {
        throw new CollaborativeDocumentCreationError(
          'invalid-parent-folder',
          'The selected shared folder no longer exists.',
          operationId,
          documentId,
          false,
        );
      }
      const title = joinCollabPath(parentPath, name);
      const existingById = documents.find(document => document.documentId === documentId);
      if (existingById) {
        const sameDocument = existingById.title === title
          && existingById.documentType === descriptor.documentType
          && (existingById.parentFolderId ?? null) === input.parentFolderId
          && existingById.metadataVersion === 2
          && existingById.fileExtension === metadata.fileExtension
          && existingById.editorId === metadata.editorId;
        if (!sameDocument) {
          throw new CollaborativeDocumentCreationError(
            'operation-conflict',
            `Document id "${documentId}" already belongs to a different shared document.`,
            operationId,
            documentId,
            true,
          );
        }
        announced = true;
      } else {
        const targetPath = normalizeCollabPath(title);
        const documentCollision = documents.some(document => (
          normalizeCollabPath(getSharedDocumentDisplayPath(document, folders)) === targetPath
        ));
        const folderCollision = folders.some(folder => (
          (folder.parentFolderId ?? null) === input.parentFolderId
          && folder.name.trim() === name
        ));
        if (documentCollision || folderCollision) {
          throw new CollaborativeDocumentCreationError(
            'name-collision',
            `A shared document or folder named "${title}" already exists.`,
            operationId,
            documentId,
            false,
          );
        }
      }

      const content = input.sourceContent ?? descriptor.creation?.defaultContent ?? '';
      if (!announced) {
        const config = await this.dependencies.resolveConfig(
          scope,
          `collab://create/${documentId}`,
          documentId,
          title,
          descriptor.documentType,
          metadata,
        );
        if (!config) {
          throw new CollaborativeDocumentCreationError(
            'config-unavailable',
            'Could not resolve team collaboration credentials for the new document.',
            operationId,
            documentId,
            false,
          );
        }
        configResolved = true;

        const requiresSeed = byteLength(content) > 0
          || (descriptor.content.strategy !== 'lexical' && descriptor.content.strategy !== 'text');
        if (requiresSeed) {
          const seed = await this.dependencies.seed({
            workspacePath: scope.scopeKey,
            documentId,
            documentType: descriptor.documentType,
            title,
            content,
          });
          if (!seed.ok) {
            throw new CollaborativeDocumentCreationError(
              'seed-failed',
              seed.error || 'The initial shared content was not acknowledged by the server.',
              operationId,
              documentId,
              false,
            );
          }
        }

        try {
          await this.dependencies.register(
            scope,
            documentId,
            title,
            descriptor.documentType,
            input.parentFolderId,
            metadata,
          );
          announced = true;
        } catch (cause) {
          throw new CollaborativeDocumentCreationError(
            'register-failed',
            cause instanceof Error ? cause.message : 'Failed to register the shared document.',
            operationId,
            documentId,
            false,
            { cause },
          );
        }
      }

      const now = existingById?.createdAt ?? this.dependencies.now();
      const document: SharedDocument = existingById ?? {
        documentId,
        teamProjectId: scope.indexConfig.teamProjectId ?? null,
        title,
        documentType: descriptor.documentType,
        ...metadata,
        createdBy: '',
        createdAt: now,
        updatedAt: now,
        parentFolderId: input.parentFolderId,
      };

      if (input.localOrigin) {
        const localOrigin = typeof input.localOrigin === 'string'
          ? { sourceFilePath: input.localOrigin }
          : input.localOrigin;
        const save = this.dependencies.saveLocalOrigin;
        if (!save) {
          throw new CollaborativeDocumentCreationError(
            'local-origin-failed',
            'Local-origin persistence is unavailable.',
            operationId,
            documentId,
            true,
          );
        }
        const originalContent = localOrigin.sourceContent ?? content;
        const result = await save({
          workspacePath: scope.scopeKey,
          documentId,
          documentType: descriptor.documentType,
          sourceFilePath: localOrigin.sourceFilePath,
          lastLocalContentHash: await this.dependencies.hashContent(originalContent),
          lastCollabContentHash: await this.dependencies.hashContent(content),
        });
        if (!result.success) {
          throw new CollaborativeDocumentCreationError(
            'local-origin-failed',
            result.error || 'Failed to save the local-origin binding.',
            operationId,
            documentId,
            true,
          );
        }
      }

      try {
        await this.dependencies.cleanup(scope, documentId);
        configResolved = false;
      } catch (cleanupError) {
        logger.ui.warn(
          '[collaborativeDocumentCreationOrchestrator] Failed to release creation config',
          cleanupError,
        );
      }

      if (input.openAfterCreate !== false) {
        // Each creation source maps to its own open source. Folding
        // share_to_team and embedded_document into `home` would credit the
        // Shared Docs home with opens it never served.
        const openSource = input.analyticsSource === 'agent_tool'
          ? 'agent_tool'
          : input.analyticsSource === 'share_to_team'
            ? 'share_to_team'
            : input.analyticsSource === 'embedded_document'
              ? 'embedded_document'
              : 'sidebar';
        this.dependencies.publishPending(
          scope,
          document,
          typeof content === 'string' ? content : undefined,
          openSource,
        );
      }
      trackTeamAnalyticsEvent('collab_document_created', {
        surface: 'desktop',
        source: input.analyticsSource ?? 'new_document',
        actorType: input.analyticsActorType ?? 'user',
        documentType: toStableAnalyticsCategory(descriptor.documentType),
        editorCategory: descriptor.editor.kind,
        nested: input.parentFolderId !== null,
        linkedDocumentCountBucket: bucketItemCount(input.analyticsLinkedDocumentCount ?? 0),
        assetMigrationOutcome: input.analyticsAssetMigrationOutcome ?? 'not_needed',
      });
      return document;
    } catch (cause) {
      if (configResolved) {
        try {
          await this.dependencies.cleanup(scope, documentId);
        } catch (cleanupError) {
          logger.ui.warn('[collaborativeDocumentCreationOrchestrator] Cleanup failed', cleanupError);
        }
      }
      const normalized = cause instanceof CollaborativeDocumentCreationError
        ? cause
        : new CollaborativeDocumentCreationError(
        announced ? 'local-origin-failed' : 'seed-failed',
        cause instanceof Error ? cause.message : String(cause),
        operationId,
        documentId,
        announced,
        { cause },
      );
      trackTeamAnalyticsEvent('collab_operation_failed', {
        surface: 'desktop',
        operation: input.analyticsSource === 'share_to_team' ? 'share_to_team' : 'create_document',
        source: input.analyticsSource ?? 'new_document',
        actorType: input.analyticsActorType ?? 'user',
        documentType: toStableAnalyticsCategory(input.descriptor.documentType),
        errorCategory: categorizeTeamAnalyticsError('document', normalized),
      });
      throw normalized;
    }
  }
}

const sharedCreationOrchestrator = new CollaborativeDocumentCreationOrchestrator();

export function createCollaborativeDocument(
  input: CreateCollaborativeDocumentInput,
): Promise<SharedDocument> {
  return sharedCreationOrchestrator.create(input);
}
