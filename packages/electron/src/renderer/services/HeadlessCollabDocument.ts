/**
 * HeadlessCollabDocument
 *
 * Acquire a shared collaborative document as an authenticated, hydrated Y.Doc
 * WITHOUT mounting an editor, and read its content through the document type's
 * registered codec.
 *
 * A shared document lives on the server and is addressable whether or not a
 * human has it on screen. Agent tools that require a mounted editor are
 * therefore asking the wrong question -- see NIM-3754, where an agent handed a
 * teammate's doc link could not read it until someone opened the tab.
 *
 * This module owns only the *acquisition*. `HeadlessCollabCommentController`
 * builds the comment surface on top of it, and the MCP read/edit handlers build
 * the content surface, so the resolve-hydrate-release dance exists once rather
 * than once per feature.
 *
 * WHY READS CAN FAIL INSTEAD OF RETURNING '': an unsynced peer's Y.Doc reads
 * empty because the room has told it nothing yet, and a doc carrying content
 * this client cannot decode reads empty for a different reason again. Both are
 * UNREACHABLE, not "the document is empty". Reporting '' to an agent that is
 * about to rewrite the document is how you lose someone's work.
 */
import { getCollabContentAdapter } from '@nimbalyst/collab-adapters';
import { parseCollabUri, type DocumentDecisionCommand, type DocumentDecisionResult } from '@nimbalyst/collab-protocol';
import type { Doc } from 'yjs';
import type { CollaborationContext } from '@nimbalyst/runtime';
import type { CollabDocumentConfig } from '../utils/collabDocumentOpener';

import {
  getSharedDocumentsForScopeKey,
  getTeamSyncProviderForScopeKey,
} from '../store/atoms/collabDocuments';
import { collaborativeEmbedProviderCache } from './CollaborativeEmbedProviderCache';
import { getCollaborativeDocumentTypeCatalog } from './CollaborativeDocumentTypeCatalog';

const HYDRATION_TIMEOUT_MS = 10_000;
const FLUSH_TIMEOUT_MS = 5_000;

export type HeadlessCollabDocumentErrorCode =
  /** The workspace's shared index has no such document. */
  | 'DOCUMENT_NOT_AVAILABLE'
  /** The document type has no usable editor/codec metadata. */
  | 'DOCUMENT_TYPE_UNAVAILABLE'
  /** Connected but never synced, or synced state could not be reached in time. */
  | 'ROOM_UNREACHABLE'
  /** The room holds state this client cannot decode. */
  | 'UNDECODABLE_CONTENT'
  /** No codec is registered for this document type in this process. */
  | 'NO_CODEC'
  /** A local mutation never reached the server. */
  | 'FLUSH_TIMEOUT';

export class HeadlessCollabDocumentError extends Error {
  constructor(
    readonly code: HeadlessCollabDocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HeadlessCollabDocumentError';
  }
}

export interface HeadlessCollabDocumentOptions {
  /** Overridable so tests can assert the unreachable path without a real wait. */
  hydrationTimeoutMs?: number;
}

export interface HeadlessCollabDocumentAcquisition {
  /** The shared-index entry, carrying title / project / extension metadata. */
  document: {
    documentId: string;
    title: string;
    documentType: string;
    fileExtension?: string | null;
    editorId?: string | null;
    teamProjectId?: string | null;
  };
  documentType: string;
  config: {
    orgId: string;
    teamMemberId: string;
    userName?: string;
    userEmail?: string;
    /** Room history endpoint access, used to record a pre-edit revision. */
    documentId?: string;
    serverUrl?: string;
    getJwt?: CollabDocumentConfig['getJwt'];
    urlExtraQuery?: string;
  };
  yDoc: Doc;
  /** The full open-document config, for mounting an editor on this replica. */
  collabConfig: CollabDocumentConfig;
  /** The replica's collaboration context: what a custom editor binds to. */
  collaboration: CollaborationContext;
  /**
   * The same DocumentSyncProvider a mounted editor would hold.
   *
   * `flushWithAck` is required, not optional: a write path that can silently
   * skip the server acknowledgement is a write path that reports success for
   * edits nobody else ever received.
   */
  syncProvider: {
    getYDoc(): Doc;
    isSynced(): boolean;
    getStatus(): string;
    hasUndecodedContent(): boolean;
    flushWithAck(timeoutMs?: number): Promise<boolean>;
    getLastSeq?(): number;
    requestDecision?(command: DocumentDecisionCommand): Promise<DocumentDecisionResult>;
    sendAwareness?(state: unknown): Promise<void>;
    sendAwarenessDeparture?(user: unknown): boolean;
  };
  replica: { getOutboxState(): string };
  /** Team sync provider for the workspace, or undefined when there is no team. */
  getTeamProvider(): ReturnType<typeof getTeamSyncProviderForScopeKey>;
  /** Settle local mutations against the room. Throws on timeout. */
  flush(): Promise<void>;
  release(): void;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  code: HeadlessCollabDocumentErrorCode,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new HeadlessCollabDocumentError(code, message);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Acquire `documentUri` as a hydrated Y.Doc with no editor mounted.
 *
 * Resolves through the authenticated embed provider cache, so the caller
 * inherits org-key unwrap, JWT handling, and the room socket without
 * reimplementing any of it. Callers MUST `release()` in a `finally`.
 */
export async function acquireHeadlessCollabDocument(
  documentUri: string,
  workspacePath: string,
  options: HeadlessCollabDocumentOptions = {},
): Promise<HeadlessCollabDocumentAcquisition> {
  const { orgId, documentId } = parseCollabUri(documentUri);
  const document = getSharedDocumentsForScopeKey(workspacePath).find(
    (candidate) => candidate.documentId === documentId,
  );
  if (!document) {
    throw new HeadlessCollabDocumentError(
      'DOCUMENT_NOT_AVAILABLE',
      `The shared document ${documentId} is not available in this workspace.`,
    );
  }

  const catalog = getCollaborativeDocumentTypeCatalog();
  const resolution = catalog.resolveMetadata(
    document.documentType,
    document.fileExtension,
    document.editorId,
  );
  if (resolution.state !== 'ready') {
    throw new HeadlessCollabDocumentError(
      'DOCUMENT_TYPE_UNAVAILABLE',
      resolution.reason,
    );
  }
  const descriptor = resolution.descriptor;
  const acquisition = await collaborativeEmbedProviderCache.acquire({
    workspacePath,
    orgId,
    documentId,
    title: document.title,
    documentType: document.documentType,
    metadata: {
      metadataVersion: 2,
      fileExtension: document.fileExtension ?? descriptor.defaultExtension,
      editorId: document.editorId ?? catalog.editorIdForDescriptor(descriptor),
    },
  });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    acquisition.release();
  };

  try {
    await waitUntil(
      () => acquisition.resource.syncProvider.isSynced(),
      options.hydrationTimeoutMs ?? HYDRATION_TIMEOUT_MS,
      'ROOM_UNREACHABLE',
      `Timed out hydrating the shared document ${documentId}; its contents are unknown, not empty.`,
    );

    return {
      document,
      documentType: document.documentType,
      config: acquisition.resource.config,
      collabConfig: acquisition.resource.config,
      collaboration: acquisition.resource.collaboration,
      yDoc: acquisition.resource.syncProvider.getYDoc(),
      syncProvider: acquisition.resource.syncProvider,
      replica: acquisition.resource.replica,
      getTeamProvider: () => getTeamSyncProviderForScopeKey(workspacePath),
      async flush() {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await waitUntil(
          () =>
            acquisition.resource.replica.getOutboxState() === 'clean' &&
            acquisition.resource.syncProvider.getStatus() === 'connected',
          FLUSH_TIMEOUT_MS,
          'FLUSH_TIMEOUT',
          'Timed out while flushing the collaborative mutation.',
        );
      },
      release,
    } as HeadlessCollabDocumentAcquisition;
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Resolve the codec for `documentType`, or fail loudly.
 *
 * A missing codec is not "an empty document" -- it means this process cannot
 * interpret the room's contents at all.
 */
export function requireCollabCodec(documentType: string) {
  const codec = getCollabContentAdapter(documentType);
  if (!codec) {
    throw new HeadlessCollabDocumentError(
      'NO_CODEC',
      `No collaborative codec is registered for document type '${documentType}'.`,
    );
  }
  return codec;
}

/**
 * The agent-facing text projection of a shared document.
 *
 * `exportToFile`, not `toPlainText`. Both would do for a read, and for markdown
 * they are literally the same function -- but only `exportToFile` is defined to
 * round-trip (`toPlainText` is documented as lossy, "not a round-trip
 * channel"). An agent reads a document in order to edit it, and an edit matches
 * the text it was given against the document. If the read used the lossy
 * projection and the write used the faithful one, every `oldText` an agent
 * quoted back to us from a non-markdown document could miss.
 */
export function projectCollabDocContent(
  codec: ReturnType<typeof requireCollabCodec>,
  yDoc: Doc,
): string {
  const exported = codec.exportToFile(yDoc);
  return typeof exported === 'string'
    ? exported
    : new TextDecoder('utf-8').decode(exported);
}

/**
 * Read `documentUri`'s content through its registered codec.
 *
 * Type-generic by construction: every shared-doc type registers a codec
 * (`rendererCollabCodecs.ts`), so markdown, code, spreadsheets, mockups, and
 * diagrams all read through the same call.
 */
export async function readHeadlessCollabDocContent(
  documentUri: string,
  workspacePath: string,
  options: HeadlessCollabDocumentOptions = {},
): Promise<string> {
  const acquisition = await acquireHeadlessCollabDocument(
    documentUri,
    workspacePath,
    options,
  );
  try {
    assertDecodable(acquisition, documentUri);
    return projectCollabDocContent(
      requireCollabCodec(acquisition.documentType),
      acquisition.yDoc,
    );
  } finally {
    acquisition.release();
  }
}

/**
 * Refuse to report or overwrite a room whose state this client cannot decode.
 * Its Y.Doc reads empty for a reason that has nothing to do with the document
 * being empty.
 */
export function assertDecodable(
  acquisition: Pick<HeadlessCollabDocumentAcquisition, 'syncProvider'>,
  documentUri: string,
): void {
  if (acquisition.syncProvider.hasUndecodedContent()) {
    throw new HeadlessCollabDocumentError(
      'UNDECODABLE_CONTENT',
      `The room for ${documentUri} holds content this client could not decode; refusing to treat it as the document's contents.`,
    );
  }
}
