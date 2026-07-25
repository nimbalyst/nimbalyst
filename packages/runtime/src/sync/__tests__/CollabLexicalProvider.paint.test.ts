import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHeadlessEditor } from '@lexical/headless';
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '@lexical/yjs';
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import type { DocumentSyncStatus } from '../documentSyncTypes';
import { CollabLexicalProvider } from '../CollabLexicalProvider';

// Minimal provider object for @lexical/yjs binding + sync helpers. Cursor
// syncing is stubbed out, so only awareness shape is needed.
const bindingProvider = {
  awareness: {
    getLocalState: () => null,
    setLocalState: () => {},
    getStates: () => new Map(),
    on: () => {},
    off: () => {},
  },
} as any;

function createSyncProviderStub(status: DocumentSyncStatus, sharedDoc: Y.Doc) {
  return {
    onAwarenessChange: () => () => {},
    setLocalAwareness: () => {},
    connect: async () => {},
    getYDoc: () => sharedDoc,
    getStatus: () => status,
  } as any;
}

function makeEditor() {
  return createHeadlessEditor({
    namespace: 'collab-paint-test',
    nodes: [],
    onError: (e) => {
      throw e;
    },
  });
}

function readText(editor: ReturnType<typeof makeEditor>): string {
  let text = '';
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

// Build a shared Y.Doc that already holds real Lexical collab content, exactly
// as a warm replica / server room would when a doc is reopened or the renderer
// is reloaded. Content is written through a real binding so the XmlText carries
// valid Lexical structure (not a bare string insert).
function populatedSharedDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  const writer = makeEditor();
  const docMap = new Map<string, Y.Doc>([['main', doc]]);
  const binding = createBinding(writer, bindingProvider, 'main', doc, docMap);
  const removeListener = writer.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding,
        bindingProvider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      );
    },
  );
  writer.update(
    () => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      root.append(paragraph);
    },
    { discrete: true },
  );
  removeListener();
  return doc;
}

// Model what @lexical/react's useYjsCollaboration does for one editor mount:
// the host's providerFactory calls prepareForBinding() then getYDoc(), Lexical
// binds to that doc, attaches observeDeep (the paint path), and calls
// provider.connect() after observers are attached.
function mountEditor(provider: CollabLexicalProvider) {
  provider.prepareForBinding(); // host providerFactory contract (NIM-1826)
  const editorDoc = provider.getYDoc();
  const editor = makeEditor();
  const docMap = new Map<string, Y.Doc>([['main', editorDoc]]);
  const binding = createBinding(editor, bindingProvider, 'main', editorDoc, docMap);
  const onYjsTreeChanges = (events: any, transaction: any) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(binding, bindingProvider, events, false, () => {});
    }
  };
  const attachObserver = () => binding.root.getSharedType().observeDeep(onYjsTreeChanges);
  const detachObserver = () => binding.root.getSharedType().unobserveDeep(onYjsTreeChanges);
  return { editor, editorDoc, attachObserver, detachObserver };
}

describe('CollabLexicalProvider warm-open paint (blank-until-reopen)', () => {
  // Regression for the Cmd+R / multi-tab-restore blank: on refresh the replica
  // is warm ('ready'), so the shared doc is already full at connect(). The
  // bridge copies it into the per-provider editorDoc (editorBytesAfterCopy > 0),
  // but the editor renders blank. The provider (and its editorDoc) outlives a
  // single editor mount, so when the editor REMOUNTS onto the same,
  // already-populated editorDoc, the fresh binding's observeDeep never sees the
  // hydration events (the reconnect replay is an idempotent no-op) -> blank.
  it('paints content when the editor remounts onto an already-populated editorDoc', async () => {
    const sharedDoc = populatedSharedDoc('warm content');
    const syncProvider = createSyncProviderStub('connected', sharedDoc);
    const provider = new CollabLexicalProvider(syncProvider);

    // First mount: observer attaches, then connect() replays the shared doc.
    const first = mountEditor(provider);
    first.attachObserver();
    await provider.connect();
    expect(readText(first.editor)).toBe('warm content'); // first mount is fine
    // Editor unmounts (StrictMode / parent remount) but the provider survives:
    first.detachObserver();

    // Second mount reuses the SAME provider. Its providerFactory contract
    // (prepareForBinding) must hand the new binding a fresh empty editorDoc so
    // connect()'s replay is observed and paints -- not the prior binding's
    // already-populated doc.
    const second = mountEditor(provider);
    second.attachObserver();
    await provider.connect();

    // The user sees this editor; it must show the content, not a blank doc.
    expect(readText(second.editor)).toBe('warm content');
    // The two mounts must be bound to distinct docs (fresh per binding).
    expect(second.editorDoc).not.toBe(first.editorDoc);
  });

  it('still delivers later shared-doc edits into the current mount after a remount', async () => {
    const sharedDoc = populatedSharedDoc('warm content');
    const syncProvider = createSyncProviderStub('connected', sharedDoc);
    const provider = new CollabLexicalProvider(syncProvider);

    const first = mountEditor(provider);
    first.attachObserver();
    await provider.connect();
    first.detachObserver();

    const second = mountEditor(provider);
    second.attachObserver();
    await provider.connect();

    // A remote edit after the remount must reach the live (second) mount's
    // editorDoc, proving the bridge was re-pointed at the fresh editorDoc, not
    // the retired one. Assert delivery via state growth (the bridge is
    // synchronous; the exact text mangles because the root already holds Lexical
    // structure).
    const before = Y.encodeStateAsUpdate(second.editorDoc).byteLength;
    sharedDoc.get('root', Y.XmlText).insert(0, 'remote ');
    expect(Y.encodeStateAsUpdate(second.editorDoc).byteLength).toBeGreaterThan(before);
  });

  it('bridges editor edits from the current mount back to the shared doc after a remount', async () => {
    const sharedDoc = populatedSharedDoc('warm content');
    const syncProvider = createSyncProviderStub('connected', sharedDoc);
    const provider = new CollabLexicalProvider(syncProvider);

    const first = mountEditor(provider);
    first.attachObserver();
    await provider.connect();
    first.detachObserver();

    const second = mountEditor(provider);
    second.attachObserver();
    await provider.connect();

    const before = Y.encodeStateAsUpdate(sharedDoc).byteLength;
    second.editorDoc.get('remount-edit', Y.Text).insert(0, 'typed after remount');

    expect(Y.encodeStateAsUpdate(sharedDoc).byteLength).toBeGreaterThan(before);
    expect(sharedDoc.get('remount-edit', Y.Text).toString()).toBe('typed after remount');
  });
});
