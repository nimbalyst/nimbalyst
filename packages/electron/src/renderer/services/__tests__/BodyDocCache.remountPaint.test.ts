// @vitest-environment node
/**
 * Tracker body remount paint (NIM-2005 follow-up).
 *
 * User-reported repro: a shared tracker item's body loads the FIRST time it is
 * opened, but is blank when you switch away and come back.
 *
 * Switching away releases the BodyDocCache entry and switching back acquires it
 * again. The second acquire hits a WARM entry whose DocumentSyncProvider is
 * already 'connected' and whose shared Y.Doc is already populated -- the exact
 * shape that has produced blank editors before (NIM-1764 / NIM-1826).
 *
 * This test drives the real CollabLexicalProvider (only DocumentSyncProvider is
 * stubbed) through acquire -> mount -> release -> acquire -> mount, and asserts
 * the SECOND mount paints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { createHeadlessEditor } from '@lexical/headless';
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';

// Stub ONLY DocumentSyncProvider; CollabLexicalProvider must be the real one
// because the bridge/claim logic under test lives there.
const sharedDocs = new Map<string, Y.Doc>();
let stubStatus = 'connected';
/** Whether the stub's flush is answered by a server `docUpdateAck`. */
let stubAcknowledgesWrites = true;

// NOTE: do not use importActual here -- the `@nimbalyst/runtime/sync` barrel
// pulls in monaco (and its CSS), which the node test environment can't load.
// Import the real CollabLexicalProvider from its concrete module instead.
vi.mock('@nimbalyst/runtime/sync', async () => {
  const real = await import('@nimbalyst/runtime/sync/CollabLexicalProvider');
  class DocumentSyncProvider {
    config: Record<string, any>;
    destroyed = false;
    constructor(config: Record<string, any>) {
      this.config = config;
      const id = String(config.documentId ?? 'doc');
      if (!sharedDocs.has(id)) sharedDocs.set(id, new Y.Doc());
    }
    getYDoc(): Y.Doc { return sharedDocs.get(String(this.config.documentId ?? 'doc'))!; }
    getStatus(): string { return stubStatus; }
    async connect(): Promise<void> { /* already connected */ }
    onAwarenessChange(): () => void { return () => {}; }
    setLocalAwareness(): void { /* no-op */ }
    setRoomMetadata(): void { /* no-op */ }
    getLastSeq(): number { return 0; }
    async flushWithAck(): Promise<boolean> { return stubAcknowledgesWrites; }
    destroy(): void { this.destroyed = true; }
  }
  return { CollabLexicalProvider: real.CollabLexicalProvider, DocumentSyncProvider };
});

// Imported once at load, not per test: BodyDocCache reaches the whole Lexical editor
// graph through MarkdownCollabContentAdapter, and loading it inside the first test
// spent most of that test's timeout under full-suite load.
import { BodyDocCache } from '../BodyDocCache';

const bindingProvider = {
  awareness: {
    getLocalState: () => null,
    setLocalState: () => {},
    getStates: () => new Map(),
    on: () => {},
    off: () => {},
  },
} as any;

function makeEditor() {
  return createHeadlessEditor({
    namespace: 'body-remount-test',
    nodes: [],
    onError: (e) => { throw e; },
  });
}

/** Seed the room's shared doc with real Lexical collab content. */
function seedSharedDoc(doc: Y.Doc, text: string): void {
  const writer = makeEditor();
  const docMap = new Map<string, Y.Doc>([['main', doc]]);
  const binding = createBinding(writer, bindingProvider, 'main', doc, docMap);
  const stop = writer.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding, bindingProvider, prevEditorState, editorState,
        dirtyElements, dirtyLeaves, normalizedNodes, tags,
      );
    },
  );
  writer.update(() => {
    const root = $getRoot();
    const p = $createParagraphNode();
    p.append($createTextNode(text));
    root.append(p);
  }, { discrete: true });
  stop();
}

/**
 * One editor mount against a collab adapter, modelling what
 * CollaborationPlugin does: bind to getYDoc(), attach observers, then connect().
 */
async function mountEditorOn(collabProvider: any, { prepare = true } = {}) {
  // The host providerFactory contract: rotate in a fresh editorDoc before
  // handing the adapter to a new binding (NIM-1826).
  if (prepare) collabProvider.prepareForBinding();
  const editorDoc: Y.Doc = collabProvider.getYDoc();
  const editor = makeEditor();
  const docMap = new Map<string, Y.Doc>([['main', editorDoc]]);
  const binding = createBinding(editor, bindingProvider, 'main', editorDoc, docMap);
  const onChanges = (events: any, tx: any) => {
    if (tx.origin !== binding) {
      syncYjsChangesToLexical(binding, bindingProvider, events, false, () => {});
    }
  };
  binding.root.getSharedType().observeDeep(onChanges);
  await collabProvider.connect();
  let text = '';
  editor.getEditorState().read(() => { text = $getRoot().getTextContent(); });
  return text;
}

/**
 * Keep the real Lexical/Yjs binding mounted so an agent-side body replacement
 * can be asserted against the editor state that was already open.
 */
async function mountLiveEditorOn(collabProvider: any) {
  collabProvider.prepareForBinding();
  const editorDoc: Y.Doc = collabProvider.getYDoc();
  const editor = makeEditor();
  const docMap = new Map<string, Y.Doc>([['main', editorDoc]]);
  const binding = createBinding(editor, bindingProvider, 'main', editorDoc, docMap);
  const onChanges = (events: any, tx: any) => {
    if (tx.origin !== binding) {
      syncYjsChangesToLexical(binding, bindingProvider, events, false, () => {});
    }
  };
  binding.root.getSharedType().observeDeep(onChanges);
  await collabProvider.connect();

  return {
    readText(): string {
      let text = '';
      editor.getEditorState().read(() => { text = $getRoot().getTextContent(); });
      return text;
    },
    destroy(): void {
      binding.root.getSharedType().unobserveDeep(onChanges);
    },
  };
}

describe('tracker body remount paint (BodyDocCache warm re-acquire)', () => {
  beforeEach(() => {
    sharedDocs.clear();
    stubStatus = 'connected';
    stubAcknowledgesWrites = true;
  });

  it('paints the body on the SECOND open after switching away and back', async () => {
    const cache = new BodyDocCache();

    const itemId = 'bug_remount_paint';
    const factory = async () => ({
      documentId: itemId,
      documentType: 'markdown' as const,
      title: 'Body',
    }) as any;

    // ---- First open: acquire, mount, paint.
    const first = await cache.acquire(itemId, factory);
    expect(first).not.toBeNull();
    seedSharedDoc(first!.syncProvider.getYDoc() as Y.Doc, 'body content');

    const firstProvider = first!.makeCollabProvider({ deferInitialSync: true });
    const firstText = await mountEditorOn(firstProvider);
    expect(firstText).toContain('body content'); // first open works today

    // ---- Switch away: the host destroys its adapter and releases the entry.
    firstProvider.destroy();
    first!.release();

    // ---- Switch back: warm entry, already 'connected', shared doc populated.
    const second = await cache.acquire(itemId, factory);
    expect(second).not.toBeNull();
    expect(second!.syncProvider).toBe(first!.syncProvider); // same warm provider

    const secondProvider = second!.makeCollabProvider({ deferInitialSync: true });
    const secondText = await mountEditorOn(secondProvider);

    // This is what the user sees as "loaded the first time, blank the second".
    expect(secondText).toContain('body content');
  });

  /**
   * The other remount shape: the EDITOR remounts (providerEpoch bump, tab/mode
   * re-render) while the collab adapter survives, so the second binding is
   * handed an editorDoc a previous binding already claimed. The documented
   * contract (NIM-1826) is that the host must call prepareForBinding() before
   * handing the adapter to a new binding, or the replay is an idempotent no-op
   * that emits no events and the editor renders blank.
   *
   * The tracker body path does honour that contract today
   * (`useTrackerContentCollab`'s providerFactory calls it), so this pins the
   * hazard rather than a live bug: it must stay observable so the contract
   * can't be quietly dropped from that factory.
   */
  it('renders blank when a reused adapter is NOT prepared for the new binding', async () => {
    const cache = new BodyDocCache();
    const itemId = 'bug_adapter_reuse_unprepared';
    const factory = async () => ({ documentId: itemId, documentType: 'markdown' as const, title: 'Body' }) as any;

    const acq = await cache.acquire(itemId, factory);
    seedSharedDoc(acq!.syncProvider.getYDoc() as Y.Doc, 'body content');
    const adapter = acq!.makeCollabProvider({ deferInitialSync: true });

    expect(await mountEditorOn(adapter)).toContain('body content');
    // Skipping prepareForBinding is precisely the bug this pins: the second
    // binding inherits a claimed, already-populated editorDoc, so the replay
    // emits no events. Asserted so the hazard can't be quietly "fixed" by
    // making prepareForBinding a no-op.
    expect(await mountEditorOn(adapter, { prepare: false })).toBe('');
  });

  it('paints when the same adapter is reused for a second binding', async () => {
    const cache = new BodyDocCache();

    const itemId = 'bug_adapter_reuse';
    const factory = async () => ({
      documentId: itemId,
      documentType: 'markdown' as const,
      title: 'Body',
    }) as any;

    const acq = await cache.acquire(itemId, factory);
    seedSharedDoc(acq!.syncProvider.getYDoc() as Y.Doc, 'body content');

    // One adapter, two successive editor mounts -- no prepareForBinding().
    const adapter = acq!.makeCollabProvider({ deferInitialSync: true });
    expect(await mountEditorOn(adapter)).toContain('body content');

    const secondMountText = await mountEditorOn(adapter);
    expect(secondMountText).toContain('body content');
  });

  it('applies an agent body write through the warm provider while the editor is bound', async () => {
    const cache = new BodyDocCache();
    const itemId = 'bug_agent_write_open_editor';
    const factory = async () => ({
      documentId: itemId,
      documentType: 'markdown' as const,
      title: 'Body',
      workspacePath: '/ws/A',
    }) as any;

    const acquisition = await cache.acquire(itemId, factory);
    expect(acquisition).not.toBeNull();
    seedSharedDoc(acquisition!.syncProvider.getYDoc() as Y.Doc, 'body before agent write');

    const adapter = acquisition!.makeCollabProvider({ deferInitialSync: true });
    const mounted = await mountLiveEditorOn(adapter);
    expect(mounted.readText()).toContain('body before agent write');

    expect(
      await cache.applyMarkdownToWarmEntry(itemId, 'body written by agent', '/ws/A'),
    ).toBe('acknowledged');
    await vi.waitFor(() => {
      expect(mounted.readText()).toContain('body written by agent');
      expect(mounted.readText()).not.toContain('body before agent write');
    });

    mounted.destroy();
    adapter.destroy();
    acquisition!.release();
    cache.dispose();
  });

  /**
   * Main deletes the plan's markdown body from disk when this window reports a
   * successful write, so "the local Y.Doc now holds it" is not a success. Drop
   * the socket between the mutation and the `docUpdateAck` and the body exists
   * only in this replica -- the room is still empty for a cold teammate.
   *
   * `unacknowledged` is deliberately distinct from `no-entry`: the replica HAS
   * been mutated, so main must not retry through its headless peer, whose own
   * `clear + insert` would merge into a second copy of the body.
   */
  it('reports an agent write the server never acknowledged as unacknowledged, not applied', async () => {
    const cache = new BodyDocCache();
    const itemId = 'bug_agent_write_never_acked';
    const factory = async () => ({
      documentId: itemId,
      documentType: 'markdown' as const,
      title: 'Body',
      workspacePath: '/ws/A',
    }) as any;

    const acquisition = await cache.acquire(itemId, factory);
    seedSharedDoc(acquisition!.syncProvider.getYDoc() as Y.Doc, 'body before agent write');
    stubAcknowledgesWrites = false;

    expect(
      await cache.applyMarkdownToWarmEntry(itemId, 'body written by agent', '/ws/A'),
    ).toBe('unacknowledged');

    acquisition!.release();
    cache.dispose();
  });

  /**
   * The cache is keyed on itemId alone, and a window can hold several projects
   * open at once. Frontmatter-backed ids (`fm:plan:<relative path>`) are unique
   * only within a workspace, so two projects that both contain `docs/plan.md`
   * produce the same key -- and an agent write for one would otherwise land in
   * the other project's document.
   */
  it('refuses an agent body write whose workspace does not match the warm entry', async () => {
    const cache = new BodyDocCache();
    const itemId = 'fm:plan:docs/plan.md';
    const factory = async () => ({
      documentId: itemId,
      documentType: 'markdown' as const,
      title: 'Body',
      workspacePath: '/ws/A',
    }) as any;

    const acquisition = await cache.acquire(itemId, factory);
    seedSharedDoc(acquisition!.syncProvider.getYDoc() as Y.Doc, 'project A body');

    expect(
      await cache.applyMarkdownToWarmEntry(itemId, 'written for project B', '/ws/B'),
    ).toBe('no-entry');

    const adapter = acquisition!.makeCollabProvider({ deferInitialSync: true });
    expect(await mountEditorOn(adapter)).toContain('project A body');

    // The owning workspace still gets served -- the refusal is about identity,
    // not about the window being busy or the entry being cold.
    expect(
      await cache.applyMarkdownToWarmEntry(itemId, 'written for project A', '/ws/A'),
    ).toBe('acknowledged');

    adapter.destroy();
    acquisition!.release();
    cache.dispose();
  });
});
