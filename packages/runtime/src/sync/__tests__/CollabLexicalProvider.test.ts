import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { DocumentSyncStatus } from '../documentSyncTypes';
import { CollabLexicalProvider } from '../CollabLexicalProvider';

function createSyncProviderStub(status: DocumentSyncStatus = 'disconnected', sharedDoc?: Y.Doc) {
  const doc = sharedDoc ?? new Y.Doc();
  return {
    onAwarenessChange: vi.fn(() => () => {}),
    setLocalAwareness: vi.fn(),
    connect: vi.fn(async () => {}),
    getYDoc: vi.fn(() => doc),
    getStatus: vi.fn(() => status),
  };
}

describe('CollabLexicalProvider', () => {
  it('fires sync immediately by default', () => {
    const syncProvider = createSyncProviderStub();
    const provider = new CollabLexicalProvider(syncProvider as any);
    const onSync = vi.fn();

    provider.on('sync', onSync);

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledWith(true);
  });

  it('defers initial sync until connected when requested', () => {
    const syncProvider = createSyncProviderStub();
    const provider = new CollabLexicalProvider(syncProvider as any, {
      deferInitialSync: true,
    });
    const onSync = vi.fn();

    provider.on('sync', onSync);
    expect(onSync).not.toHaveBeenCalled();

    provider.handleStatusChange('syncing' as DocumentSyncStatus);
    expect(onSync).not.toHaveBeenCalled();

    provider.handleStatusChange('connected' as DocumentSyncStatus);
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledWith(true);
  });

  it('catches up a deferred listener when a warm provider is already connected', () => {
    const syncProvider = createSyncProviderStub('connected');
    const provider = new CollabLexicalProvider(syncProvider as any, {
      deferInitialSync: true,
    });
    const onSync = vi.fn();

    provider.on('sync', onSync);

    expect(onSync).toHaveBeenCalledOnce();
    expect(onSync).toHaveBeenCalledWith(true);
  });

  // Lexical's CollaborationPlugin only paints content it OBSERVES as Y.Doc
  // events after its binding mounts -- a doc that is already populated at
  // binding time renders blank (NIM-1764: warm replica-cache reopen, and any
  // store-hydrated open). The provider therefore binds Lexical to a fresh
  // per-mount editor doc and replays the shared doc's state at connect(),
  // which the plugin calls after its observers are attached.
  describe('per-mount editor doc bridge (NIM-1764)', () => {
    function populatedSharedDoc(text: string): Y.Doc {
      const doc = new Y.Doc();
      doc.get('root', Y.XmlText).insert(0, text);
      return doc;
    }

    it('delivers pre-populated shared state as observable events after connect()', async () => {
      const sharedDoc = populatedSharedDoc('warm content');
      const syncProvider = createSyncProviderStub('connected', sharedDoc);
      const provider = new CollabLexicalProvider(syncProvider as any);

      const editorDoc = provider.getYDoc();
      expect(editorDoc).not.toBe(sharedDoc);
      // Blank-editor precondition: nothing painted before connect.
      expect(editorDoc.get('root', Y.XmlText).toString()).toBe('');

      const observed = vi.fn();
      editorDoc.get('root', Y.XmlText).observeDeep(observed);

      await provider.connect();

      expect(observed).toHaveBeenCalled();
      expect(editorDoc.get('root', Y.XmlText).toString()).toBe('warm content');
    });

    it('bridges local editor edits into the shared doc with a local (sendable) origin', async () => {
      const sharedDoc = populatedSharedDoc('warm content');
      const syncProvider = createSyncProviderStub('connected', sharedDoc);
      const provider = new CollabLexicalProvider(syncProvider as any);
      await provider.connect();

      const sharedOrigins: unknown[] = [];
      sharedDoc.on('update', (_update: Uint8Array, origin: unknown) => {
        sharedOrigins.push(origin);
      });

      const editorDoc = provider.getYDoc();
      editorDoc.get('root', Y.XmlText).insert(0, 'typed ');

      expect(sharedDoc.get('root', Y.XmlText).toString()).toBe('typed warm content');
      // DocumentSync's update observer treats REMOTE/SNAPSHOT/replica-internal
      // origins as non-local and drops them; the bridged origin must not be
      // one of those (here: simply assert it is a provider-owned marker, not
      // the editor doc's own origin passthrough of null).
      expect(sharedOrigins).toHaveLength(1);
      expect(sharedOrigins[0]).not.toBeNull();
    });

    it('bridges remote shared-doc updates into the editor doc after connect()', async () => {
      const sharedDoc = populatedSharedDoc('warm content');
      const syncProvider = createSyncProviderStub('connected', sharedDoc);
      const provider = new CollabLexicalProvider(syncProvider as any);
      await provider.connect();

      sharedDoc.get('root', Y.XmlText).insert(0, 'remote ');

      expect(provider.getYDoc().get('root', Y.XmlText).toString()).toBe('remote warm content');
    });

    it('does not echo bridged updates back and forth', async () => {
      const sharedDoc = populatedSharedDoc('warm content');
      const syncProvider = createSyncProviderStub('connected', sharedDoc);
      const provider = new CollabLexicalProvider(syncProvider as any);
      await provider.connect();

      let sharedUpdates = 0;
      let editorUpdates = 0;
      sharedDoc.on('update', () => { sharedUpdates++; });
      provider.getYDoc().on('update', () => { editorUpdates++; });

      provider.getYDoc().get('root', Y.XmlText).insert(0, 'a');
      sharedDoc.get('root', Y.XmlText).insert(0, 'b');

      // One edit on each side = exactly one update event per doc per edit.
      expect(sharedUpdates).toBe(2);
      expect(editorUpdates).toBe(2);
    });

    it('detaches from the shared doc on destroy()', async () => {
      const sharedDoc = populatedSharedDoc('warm content');
      const syncProvider = createSyncProviderStub('connected', sharedDoc);
      const provider = new CollabLexicalProvider(syncProvider as any);
      await provider.connect();

      const editorDoc = provider.getYDoc();
      provider.destroy();

      sharedDoc.get('root', Y.XmlText).insert(0, 'after destroy ');
      expect(editorDoc.get('root', Y.XmlText).toString()).toBe('warm content');
    });
  });
});
