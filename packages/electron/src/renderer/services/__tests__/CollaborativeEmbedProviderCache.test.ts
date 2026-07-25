import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncMocks = vi.hoisted(() => ({
  providerOptions: [] as any[],
  replicaOptions: [] as any[],
  replicaDestroy: vi.fn(async () => {}),
}));

vi.mock('@nimbalyst/runtime/sync', () => ({
  DocumentSyncProvider: class {
    constructor(options: any) {
      syncMocks.providerOptions.push(options);
    }
    getYDoc() { return {}; }
    async connect() {}
    destroy() {}
  },
  LocalDocumentReplica: class {
    whenReady = Promise.resolve();
    constructor(options: any) {
      syncMocks.replicaOptions.push(options);
    }
    destroy = syncMocks.replicaDestroy;
  },
}));
vi.mock('../../components/TabEditor/collabExtensionHost', () => ({
  createCollaborationContext: vi.fn(() => ({})),
  createExtensionAwarenessBridge: vi.fn(() => ({
    awareness: {},
    destroy: vi.fn(),
  })),
  notifyCollabStatus: vi.fn(),
}));
vi.mock('../../store/atoms/documentSyncRegistry', () => ({
  documentSyncRegistry: { register: vi.fn(), unregister: vi.fn() },
}));
vi.mock('../../utils/collabDocumentOpener', () => ({
  resolveCollabConfigForUri: vi.fn(),
}));
vi.mock('../ElectronLocalReplicaStore', () => ({
  ElectronLocalReplicaStore: class {
    constructor(readonly workspacePath: string) {}
  },
}));

import {
  CollaborativeEmbedProviderCache,
  collaborativeEmbedResourceKey,
  createDefaultResource,
  parseCollaborativeEmbedReference,
} from '../CollaborativeEmbedProviderCache';
import { resolveCollabConfigForUri } from '../../utils/collabDocumentOpener';

beforeEach(() => {
  syncMocks.providerOptions.length = 0;
  syncMocks.replicaOptions.length = 0;
  syncMocks.replicaDestroy.mockClear();
  vi.mocked(resolveCollabConfigForUri).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CollaborativeEmbedProviderCache', () => {
  it('refcounts duplicate embeds and destroys the child attachment after the final release', async () => {
    const destroy = vi.fn();
    const close = vi.fn(async () => {});
    const createResource = vi.fn(async () => ({
      config: { orgId: 'team-1', documentId: 'mockup-1' },
      syncProvider: { destroy },
      collaboration: {},
      destroy,
    }));
    const cache = new CollaborativeEmbedProviderCache({
      createResource: createResource as never,
      close,
    });
    const request = {
      workspacePath: '/workspace',
      orgId: 'team-1',
      documentId: 'mockup-1',
      title: 'Wireframe',
      documentType: 'mockup',
      metadata: {
        metadataVersion: 2 as const,
        fileExtension: '.mockup.html',
        editorId: 'com.nimbalyst.mockup',
      },
    };

    const first = await cache.acquire(request);
    const second = await cache.acquire(request);
    expect(createResource).toHaveBeenCalledOnce();
    expect(first.resource).toBe(second.resource);

    first.release();
    expect(destroy).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    second.release();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledWith('/workspace', 'mockup-1');
  });

  it('keys a resource by value so an equal-but-new request never re-acquires', () => {
    const request = {
      workspacePath: '/workspace',
      orgId: 'team-1',
      documentId: 'mockup-1',
      title: 'Wireframe',
      documentType: 'mockup',
      metadata: {
        metadataVersion: 2 as const,
        fileExtension: '.mockup.html',
        editorId: 'com.nimbalyst.mockup',
      },
    };

    // A TeamRoom broadcast rebuilds the shared-document array, so the embed
    // re-derives an equal request object. That must not disconnect the room.
    expect(collaborativeEmbedResourceKey({ ...request, metadata: { ...request.metadata } }))
      .toBe(collaborativeEmbedResourceKey(request));
    // Nor may a rename, which changes only the display title.
    expect(collaborativeEmbedResourceKey({ ...request, title: 'Renamed' }))
      .toBe(collaborativeEmbedResourceKey(request));

    // A genuinely different room or editor configuration must re-acquire.
    expect(collaborativeEmbedResourceKey({ ...request, documentId: 'mockup-2' }))
      .not.toBe(collaborativeEmbedResourceKey(request));
    expect(collaborativeEmbedResourceKey({
      ...request,
      metadata: { ...request.metadata, editorId: 'other.editor' },
    })).not.toBe(collaborativeEmbedResourceKey(request));
  });

  it('parses only canonical deep links that carry both document and org identity', () => {
    expect(
      parseCollaborativeEmbedReference(
        'nimbalyst://doc/mockup%2F1?orgId=team%201',
      ),
    ).toEqual({ documentId: 'mockup/1', orgId: 'team 1' });
    expect(
      parseCollaborativeEmbedReference('nimbalyst://doc/mockup-1'),
    ).toBeNull();
    expect(
      parseCollaborativeEmbedReference('https://example.com/mockup-1'),
    ).toBeNull();
  });

  it('backs a default child provider with the durable workspace replica store', async () => {
    vi.mocked(resolveCollabConfigForUri).mockResolvedValue({
      workspacePath: '/workspace',
      orgId: 'team-1',
      documentId: 'mockup-1',
      title: 'Wireframe',
      documentType: 'mockup.html',
      keyCustody: 'server-managed',
      serverUrl: 'ws://collab.test',
      accountId: 'account-1',
      userId: 'user-1',
      getJwt: async () => 'token',
    });
    const setReplicaProviderAttached = vi.fn(async () => {});
    const closeDoc = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: {
          setReplicaProviderAttached,
          setPendingUpdate: vi.fn(async () => {}),
          closeDoc,
        },
      },
    });

    const resource = await createDefaultResource({
      workspacePath: '/workspace',
      orgId: 'team-1',
      documentId: 'mockup-1',
      title: 'Wireframe',
      documentType: 'mockup.html',
      metadata: {
        metadataVersion: 2,
        fileExtension: '.mockup.html',
        editorId: 'com.nimbalyst.mockuplm',
      },
    });

    expect(syncMocks.replicaOptions).toHaveLength(1);
    expect(syncMocks.replicaOptions[0]).toMatchObject({
      identity: {
        accountId: 'account-1',
        orgId: 'team-1',
        documentId: 'mockup-1',
      },
      documentType: 'mockup.html',
      store: { workspacePath: '/workspace' },
    });
    expect(syncMocks.providerOptions[0].replica).toBeDefined();
    expect(setReplicaProviderAttached).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'mockup-1' }),
      expect.any(String),
      true,
    );

    resource.destroy();
    await vi.waitFor(() => {
      expect(syncMocks.replicaDestroy).toHaveBeenCalledOnce();
      expect(setReplicaProviderAttached).toHaveBeenLastCalledWith(
        expect.objectContaining({ documentId: 'mockup-1' }),
        expect.any(String),
        false,
      );
    });
  });
});
