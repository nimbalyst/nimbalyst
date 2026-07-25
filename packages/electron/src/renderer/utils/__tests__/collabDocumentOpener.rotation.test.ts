import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../logger', () => ({
  logger: { ui: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
}));
import { buildCollabUri } from '../collabUri';
import {
  getCollabConfig,
  openCollabDocument,
  registerCollabConfig,
  removeCollabConfig,
  resolveCollabConfigForUri,
  updateCollabConfigDisplayMetadata,
} from '../collabDocumentOpener';

const workspacePath = '/workspace';
const documentId = 'doc-rotation';
const uri = buildCollabUri('org-a', documentId);

afterEach(() => {
  removeCollabConfig(uri);
  vi.unstubAllGlobals();
});

describe('collab document key rotation resolution', () => {
  it('passes a title-safe leaf name into tab creation', () => {
    const addTab = vi.fn(() => 'tab-1');

    openCollabDocument({
      workspacePath,
      orgId: 'org-a',
      documentId: '1af74157-fe92-481b-9be3-4ed7cc6f5625',
      title: 'Specs/Auth/Architecture Plan',
      documentType: 'markdown',
      keyCustody: 'server-managed',
      serverUrl: 'ws://sync',
      accountId: 'account-a',
      userId: 'user-a',
      getJwt: async () => 'token',
      addTab,
    });

    expect(addTab).toHaveBeenCalledWith(
      expect.stringContaining(':doc:1af74157-fe92-481b-9be3-4ed7cc6f5625'),
      '',
      true,
      'Architecture Plan',
    );
  });

  it('restores a collaborative tab with its persisted pinned state', () => {
    const addTab = vi.fn(() => 'tab-1');

    openCollabDocument({
      workspacePath,
      orgId: 'org-a',
      documentId: 'pinned-doc',
      title: 'Pinned document',
      documentType: 'markdown',
      keyCustody: 'server-managed',
      serverUrl: 'ws://sync',
      accountId: 'account-a',
      userId: 'user-a',
      getJwt: async () => 'token',
      addTab,
      isPinned: true,
    });

    expect(addTab).toHaveBeenCalledWith(
      expect.stringContaining(':doc:pinned-doc'),
      '',
      true,
      'Pinned document',
      { isPinned: true },
    );
  });

  it('keeps late display metadata in the registered config for index gaps', () => {
    const addTab = vi.fn(() => 'tab-1');
    const displayDocumentId = 'doc-display';
    const displayUri = buildCollabUri('org-a', displayDocumentId);

    openCollabDocument({
      workspacePath,
      orgId: 'org-a',
      documentId: displayDocumentId,
      title: '',
      documentType: 'markdown',
      keyCustody: 'server-managed',
      serverUrl: 'ws://sync',
      accountId: 'account-a',
      userId: 'user-a',
      getJwt: async () => 'token',
      addTab,
    });

    updateCollabConfigDisplayMetadata(displayUri, {
      title: 'Architecture Plan',
      displayPath: 'Specs/Auth/Architecture Plan',
    });

    expect(getCollabConfig(displayUri)).toMatchObject({
      title: 'Architecture Plan',
      displayPath: 'Specs/Auth/Architecture Plan',
    });
    removeCollabConfig(displayUri);
  });

  it('keeps V2 editor metadata when resolving a non-markdown config', async () => {
    const extensionDocumentId = 'drawing-v2';
    const extensionUri = buildCollabUri('org-a', extensionDocumentId);
    const open = vi.fn(async () => ({
      success: true,
      config: {
        orgId: 'org-a',
        documentId: extensionDocumentId,
        title: 'Drawing.excalidraw',
        documentType: 'excalidraw',
        keyCustody: 'server-managed' as const,
        orgKeyBase64: '',
        serverUrl: 'ws://sync',
        accountId: 'account-a',
        userId: 'user-a',
      },
    }));
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: {
          open,
          getJwt: vi.fn(async () => ({ success: true, jwt: 'token' })),
        },
      },
    });

    const config = await resolveCollabConfigForUri(
      workspacePath,
      extensionUri,
      extensionDocumentId,
      'Drawing.excalidraw',
      'excalidraw',
      {
        metadata: {
          metadataVersion: 2,
          fileExtension: '.excalidraw',
          editorId: 'com.nimbalyst.excalidraw',
        },
      },
    );

    expect(config).toMatchObject({
      documentType: 'excalidraw',
      metadataVersion: 2,
      fileExtension: '.excalidraw',
      editorId: 'com.nimbalyst.excalidraw',
    });
    removeCollabConfig(extensionUri);
  });

  it('bypasses cached aliases and decrypts with the freshly fetched key', async () => {
    const oldKeyBytes = new Uint8Array(32).fill(1);
    const newKeyBytes = new Uint8Array(32).fill(2);
    const oldDocumentKey = await crypto.subtle.importKey(
      'raw', oldKeyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    );
    registerCollabConfig({
      workspacePath,
      orgId: 'org-a',
      documentId,
      title: 'Rotating doc',
      documentType: 'markdown',
      metadataVersion: 2,
      fileExtension: '.md',
      editorId: 'builtin.lexical',
      keyCustody: 'legacy-e2e',
      documentKey: oldDocumentKey,
      orgKeyFingerprint: 'fingerprint-v1',
      serverUrl: 'ws://old',
      accountId: 'account-a',
      userId: 'user-a',
      getJwt: async () => 'old-token',
    });
    const open = vi.fn(async () => ({
      success: true,
      config: {
        workspacePath,
        orgId: 'org-a',
        documentId,
        title: 'Rotating doc',
        documentType: 'markdown',
        keyCustody: 'legacy-e2e' as const,
        orgKeyBase64: btoa(String.fromCharCode(...newKeyBytes)),
        orgKeyFingerprint: 'fingerprint-v2',
        serverUrl: 'ws://new',
        accountId: 'account-a',
        userId: 'user-a',
      },
    }));
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: {
          open,
          getJwt: vi.fn(async () => ({ success: true, jwt: 'new-token' })),
        },
      },
    });

    const refreshed = await resolveCollabConfigForUri(
      workspacePath,
      uri,
      documentId,
      'Rotating doc',
      'markdown',
      { forceRefresh: true },
    );

    expect(open).toHaveBeenCalledOnce();
    expect(refreshed).toMatchObject({
      orgKeyFingerprint: 'fingerprint-v2',
      serverUrl: 'ws://new',
      metadataVersion: 2,
      fileExtension: '.md',
      editorId: 'builtin.lexical',
    });
    const encryptingKey = await crypto.subtle.importKey(
      'raw', newKeyBytes, { name: 'AES-GCM' }, false, ['encrypt'],
    );
    const iv = new Uint8Array(12).fill(3);
    const plaintext = new TextEncoder().encode('post-rotation update');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptingKey, plaintext);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      refreshed!.documentKey!,
      encrypted,
    );
    expect(new TextDecoder().decode(decrypted)).toBe('post-rotation update');
  });

  it('can resolve an uncached child attachment without replacing a tab config', async () => {
    const childDocumentId = 'embedded-child';
    const childUri = buildCollabUri('org-a', childDocumentId);
    const existing = {
      workspacePath,
      orgId: 'org-a',
      documentId: childDocumentId,
      title: 'Existing tab config',
      documentType: 'mockup',
      keyCustody: 'server-managed' as const,
      serverUrl: 'ws://existing',
      accountId: 'account-a',
      userId: 'user-a',
      getJwt: async () => 'old-token',
    };
    registerCollabConfig(existing);
    const open = vi.fn(async () => ({
      success: true,
      config: {
        orgId: 'org-a',
        documentId: childDocumentId,
        title: 'Embedded child',
        documentType: 'mockup',
        keyCustody: 'server-managed' as const,
        orgKeyBase64: '',
        serverUrl: 'ws://embedded',
        urlExtraQuery: 'test_user_id=user-a&test_org_id=org-a',
        accountId: 'account-a',
        userId: 'user-a',
      },
    }));
    const wsConnect = vi.fn(async () => ({ success: true, wsId: 'embedded-ws' }));
    vi.stubGlobal('window', {
      electronAPI: {
        documentSync: {
          open,
          getJwt: vi.fn(async () => ({ success: true, jwt: 'token' })),
          onWsEvent: vi.fn(() => vi.fn()),
          wsConnect,
          wsSend: vi.fn(),
          wsClose: vi.fn(),
        },
      },
    });

    const embedded = await resolveCollabConfigForUri(
      workspacePath,
      childUri,
      childDocumentId,
      'Embedded child',
      'mockup',
      { cache: false },
    );

    expect(open).toHaveBeenCalledOnce();
    expect(embedded?.serverUrl).toBe('ws://embedded');
    expect(embedded?.urlExtraQuery).toBe('test_user_id=user-a&test_org_id=org-a');
    embedded?.createWebSocket?.('ws://embedded/sync/room?token=token');
    await vi.waitFor(() => {
      expect(wsConnect).toHaveBeenCalledWith(
        'ws://embedded/sync/room?token=token&test_user_id=user-a&test_org_id=org-a',
      );
    });
    expect(getCollabConfig(childUri)).toBe(existing);
    removeCollabConfig(childUri);
  });
});
