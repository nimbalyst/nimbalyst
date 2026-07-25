import {
  DocumentSyncProvider,
  LocalDocumentReplica,
  type DocumentSyncStatus,
} from '@nimbalyst/runtime/sync';
import type { CollaborationContext } from '@nimbalyst/runtime';

import {
  createCollaborationContext,
  createExtensionAwarenessBridge,
  notifyCollabStatus,
} from '../components/TabEditor/collabExtensionHost';
import { documentSyncRegistry } from '../store/atoms/documentSyncRegistry';
import { buildCollabUri } from '../utils/collabUri';
import {
  resolveCollabConfigForUri,
  type CollabDocumentConfig,
} from '../utils/collabDocumentOpener';
import { ElectronLocalReplicaStore } from './ElectronLocalReplicaStore';

export interface CollaborativeEmbedReference {
  orgId: string;
  documentId: string;
}

export interface CollaborativeEmbedProviderRequest
  extends CollaborativeEmbedReference {
  workspacePath: string;
  title: string;
  documentType: string;
  metadata: {
    metadataVersion: 2;
    fileExtension: string;
    editorId: string;
  };
}

export interface CollaborativeEmbedProviderResource {
  config: CollabDocumentConfig;
  syncProvider: DocumentSyncProvider;
  collaboration: CollaborationContext;
  destroy(): void;
}

export interface CollaborativeEmbedProviderAcquisition {
  resource: CollaborativeEmbedProviderResource;
  release(): void;
}

interface CacheEntry {
  resource: CollaborativeEmbedProviderResource;
  request: CollaborativeEmbedProviderRequest;
  refCount: number;
}

interface CollaborativeEmbedProviderCacheDependencies {
  createResource(
    request: CollaborativeEmbedProviderRequest,
  ): Promise<CollaborativeEmbedProviderResource>;
  close(workspacePath: string, documentId: string): Promise<void>;
}

export function parseCollaborativeEmbedReference(
  href: string,
): CollaborativeEmbedReference | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'nimbalyst:' || url.hostname !== 'doc') return null;
    const encodedDocumentId = url.pathname.replace(/^\/+/, '');
    const encodedOrgId = url.searchParams.get('orgId');
    if (!encodedDocumentId || !encodedOrgId) return null;
    return {
      documentId: decodeURIComponent(encodedDocumentId),
      orgId: encodedOrgId,
    };
  } catch {
    return null;
  }
}

/**
 * Value identity of everything that decides WHICH child room a request opens
 * and how it is configured. Consumers key their acquire effect on this rather
 * than on the request object, so a re-render that produces an equal-but-new
 * request never tears down a live provider. Deliberately excludes `title` --
 * a rename must not drop the websocket.
 */
export function collaborativeEmbedResourceKey(
  request: CollaborativeEmbedProviderRequest,
): string {
  return JSON.stringify([
    cacheKey(request),
    request.documentType,
    request.metadata.fileExtension,
    request.metadata.editorId,
  ]);
}

function cacheKey(request: CollaborativeEmbedProviderRequest): string {
  return [
    request.workspacePath,
    request.orgId,
    request.documentId,
  ].join('\u0000');
}

export async function createDefaultResource(
  request: CollaborativeEmbedProviderRequest,
): Promise<CollaborativeEmbedProviderResource> {
  const uri = buildCollabUri(request.orgId, request.documentId);
  const config = await resolveCollabConfigForUri(
    request.workspacePath,
    uri,
    request.documentId,
    request.title,
    request.documentType,
    { metadata: request.metadata, cache: false },
  );
  if (!config) {
    throw new Error(`Could not open shared document ${request.documentId}.`);
  }
  if (config.orgId !== request.orgId) {
    await window.electronAPI?.documentSync?.closeDoc?.(request.documentId).catch(() => undefined);
    throw new Error('The embedded document belongs to a different team.');
  }

  let syncProvider: DocumentSyncProvider | null = null;
  let bridge: ReturnType<typeof createExtensionAwarenessBridge> | null = null;
  let replica: LocalDocumentReplica | null = null;
  const replicaIdentity = {
    accountId: config.accountId,
    orgId: config.orgId,
    documentId: config.documentId,
  };
  const replicaAttachmentId = crypto.randomUUID();
  let replicaAttached = false;

  try {
    replica = new LocalDocumentReplica({
      identity: replicaIdentity,
      documentType: config.documentType ?? request.documentType,
      store: new ElectronLocalReplicaStore(config.workspacePath),
    });
    const attachReplica = window.electronAPI.documentSync.setReplicaProviderAttached(
      replicaIdentity,
      replicaAttachmentId,
      true,
    ).then(() => {
      replicaAttached = true;
    });
    await Promise.all([
      replica.whenReady,
      attachReplica,
    ]);
    syncProvider = new DocumentSyncProvider({
      replica,
      serverUrl: config.serverUrl,
      getJwt: config.getJwt,
      orgId: config.orgId,
      keyCustody: config.keyCustody,
      documentKey: config.documentKey,
      legacyDocumentKey: config.legacyDocumentKey,
      legacyDocumentKeys: config.legacyDocumentKeys,
      orgKeyFingerprint: config.orgKeyFingerprint,
      userId: config.userId,
      documentId: config.documentId,
      createWebSocket: config.createWebSocket,
      initialPendingUpdateBase64: config.pendingUpdateBase64,
      onStatusChange: (status: DocumentSyncStatus) => {
        if (syncProvider) notifyCollabStatus(syncProvider, status);
      },
      onPendingUpdateChange: async pendingUpdateBase64 => {
        await window.electronAPI?.documentSync?.setPendingUpdate?.(
          config.workspacePath,
          config.orgId,
          config.documentId,
          pendingUpdateBase64,
        );
      },
      reviewGateEnabled: false,
    });
    bridge = createExtensionAwarenessBridge({
      syncProvider,
      yDoc: syncProvider.getYDoc(),
      user: {
        id: config.userId,
        name: config.userName ?? config.userId,
        color: '#3A8FD6',
      },
    });
    const collaboration = createCollaborationContext({
      syncProvider,
      awareness: bridge.awareness,
      activeConfig: config,
    });
    documentSyncRegistry.register(syncProvider);
    await syncProvider.connect();
    const connectedProvider = syncProvider;
    const connectedBridge = bridge;
    const connectedReplica = replica;

    return {
      config,
      syncProvider: connectedProvider,
      collaboration,
      destroy() {
        documentSyncRegistry.unregister(connectedProvider);
        connectedBridge.destroy();
        connectedProvider.destroy();
        void connectedReplica.destroy();
        void window.electronAPI.documentSync.setReplicaProviderAttached(
          replicaIdentity,
          replicaAttachmentId,
          false,
        );
      },
    };
  } catch (error) {
    if (syncProvider) {
      documentSyncRegistry.unregister(syncProvider);
      bridge?.destroy();
      syncProvider.destroy();
    }
    await replica?.destroy().catch(() => undefined);
    if (replicaAttached) {
      await window.electronAPI.documentSync.setReplicaProviderAttached(
        replicaIdentity,
        replicaAttachmentId,
        false,
      ).catch(() => undefined);
    }
    await window.electronAPI?.documentSync?.closeDoc?.(request.documentId).catch(() => undefined);
    throw error;
  }
}

const defaultDependencies: CollaborativeEmbedProviderCacheDependencies = {
  createResource: createDefaultResource,
  close: async (_workspacePath, documentId) => {
    await window.electronAPI?.documentSync?.closeDoc?.(documentId);
  },
};

export class CollaborativeEmbedProviderCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<
    string,
    Promise<CollaborativeEmbedProviderResource>
  >();

  constructor(
    private readonly dependencies: CollaborativeEmbedProviderCacheDependencies =
      defaultDependencies,
  ) {}

  async acquire(
    request: CollaborativeEmbedProviderRequest,
  ): Promise<CollaborativeEmbedProviderAcquisition> {
    const key = cacheKey(request);
    let entry = this.entries.get(key);
    if (!entry) {
      let resourcePromise = this.pending.get(key);
      if (!resourcePromise) {
        resourcePromise = this.dependencies.createResource(request);
        this.pending.set(key, resourcePromise);
      }
      const resource = await resourcePromise.finally(() => {
        if (this.pending.get(key) === resourcePromise) this.pending.delete(key);
      });
      entry = this.entries.get(key);
      if (!entry) {
        entry = { resource, request, refCount: 0 };
        this.entries.set(key, entry);
      } else if (entry.resource !== resource) {
        resource.destroy();
        await this.dependencies.close(request.workspacePath, request.documentId);
      }
    }

    entry.refCount += 1;
    let released = false;
    return {
      resource: entry.resource,
      release: () => {
        if (released) return;
        released = true;
        entry!.refCount -= 1;
        if (entry!.refCount > 0) return;
        this.entries.delete(key);
        void this.destroyEntry(entry!);
      },
    };
  }

  private async destroyEntry(entry: CacheEntry): Promise<void> {
    entry.resource.destroy();
    await this.dependencies.close(
      entry.request.workspacePath,
      entry.request.documentId,
    );
  }
}

export const collaborativeEmbedProviderCache =
  new CollaborativeEmbedProviderCache();
