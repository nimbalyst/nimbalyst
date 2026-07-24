// @vitest-environment jsdom
/**
 * Shared tracker body: warm-reopen paint harness.
 *
 * STATUS: this harness does NOT currently reproduce NIM-1985 ("body renders on
 * the first open, blank on every reopen"). Everything below is GREEN. Read the
 * "What this ruled out" section before using it -- do not mistake a passing run
 * here for a working feature in the app.
 *
 * WHY IT EXISTS
 * -------------
 * Three separate fixes for NIM-1985 shipped with passing unit tests and left
 * the app broken. Those tests hand-rolled `createBinding` + `observeDeep`,
 * which bypasses the real `<CollaborationPlugin>` lifecycle. This harness
 * drives the real thing instead:
 *
 *   useTrackerContentCollab -> BodyDocCache -> real CollabLexicalProvider
 *     -> real NimbalystEditor -> real <CollaborationPlugin>
 *
 * The ONLY mocked layer is the transport: `DocumentSyncProvider` is replaced by
 * a fake that owns a Y.Doc, persists its state into an in-memory "room", and
 * flips to 'connected'. Nothing in the Lexical/Yjs paint path is stubbed, and
 * the tree runs under `<React.StrictMode>` (as `src/renderer/index.tsx` does).
 *
 * FIDELITY EVIDENCE
 * -----------------
 * Live instrumentation of the real bug recorded this signature on a reopen:
 *   1 providerFactory, 1 prepareForBinding, 2 connect(), 4 on('sync')
 *   on('sync') registered while status=connected, editorBytes=2, willFire=true
 *   connect  sharedBytes=10482  editorBytesBefore=2 -> after=10482
 *   connect  editorBytesBefore=10482 (no-op)
 * This harness reproduces that signature byte-for-byte (see
 * `trackerBodyDiag.test.tsx`, which dumps the trace) -- and still paints.
 *
 * WHAT THIS RULED OUT
 * -------------------
 * The theory all three failed fixes were built on -- "the shared bytes reach
 * the per-mount editorDoc but Lexical never paints them" -- is FALSE at the
 * lifecycle level. With the real plugin, the connect()-time bridge replay
 * paints reliably across every reopen shape modelled here:
 *   - unmount / remount against a warm BodyDocCache entry
 *   - React 19 `<Activity>` hide/show (which is what Tracker mode actually
 *     does -- App.tsx:2291 -- effects unmount but component state and the
 *     `isProviderInitialized` / `isBindingInitialized` refs survive)
 *   - two simultaneous consumers of one BodyDocCache entry (Trackers-mode
 *     instance hidden + Agent-mode tracker tab visible)
 *   - reopen with NO cold-paint seed, so the Y.Doc replay is the only possible
 *     source of content
 *
 * So the real failure is NOT ordering of connect / sync / bootstrap. It is
 * either environmental (real Chromium DOM, focus, selection, async
 * reconciliation) or lives in a TrackerItemDetail-level layer this harness does
 * not render (the `hasSyncedOnce` curtain, `contentLoaded` gating,
 * `useColdPaintFallback`, `saveContent(..., guardEmpty)`). The next vehicle
 * should be Playwright against the real app, not another jsdom test.
 */

import React, { Activity, useMemo } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Transport fake (the only mocked layer)
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  /** documentId -> encoded room state. Survives provider churn, like the server. */
  rooms: new Map<string, Uint8Array>(),
}));

vi.mock('@nimbalyst/runtime/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime/sync')>();
  const Yjs = await import('yjs');

  class FakeDocumentSyncProvider {
    private doc = new Yjs.Doc();
    private status = 'disconnected';
    private readonly documentId: string;
    private destroyed = false;

    constructor(private config: any) {
      this.documentId = config.documentId;
      this.doc.on('update', () => {
        if (this.destroyed) return;
        h.rooms.set(this.documentId, Yjs.encodeStateAsUpdate(this.doc));
      });
    }

    getYDoc() { return this.doc; }
    getStatus() { return this.status; }

    async connect() {
      if (this.status === 'connected') return;
      const serverState = h.rooms.get(this.documentId);
      if (serverState) Yjs.applyUpdate(this.doc, serverState, 'remote');
      this.status = 'connected';
      this.config.onStatusChange?.('connected');
    }

    disconnect() { /* soft; the host owns lifecycle */ }
    destroy() { this.destroyed = true; }
    onAwarenessChange() { return () => {}; }
    setLocalAwareness() {}
    setRoomMetadata() {}
    acceptRemoteChanges() {}
    rejectRemoteChanges() {}
  }

  return { ...actual, DocumentSyncProvider: FakeDocumentSyncProvider };
});

vi.mock('../../utils/collabDocumentOpener', () => ({
  resolveCollabConfigForUri: vi.fn(async (_w: string, _u: string, documentId: string) => ({
    serverUrl: 'wss://test.invalid',
    getJwt: async () => 'jwt',
    orgId: 'org-1',
    keyCustody: 'server',
    userId: 'user-1',
    userName: 'Test User',
    userEmail: 'test@example.com',
    documentId,
    createWebSocket: () => {
      throw new Error('transport is faked; createWebSocket must never be called');
    },
  })),
}));

vi.mock('@nimbalyst/collab-adapters', () => ({
  getCollabContentAdapter: () => null,
  exportCollabRecoveryPlaintext: () => null,
}));

// Imports below must come after vi.mock so the mocked modules are used.
// Deep imports, not the `@nimbalyst/runtime/editor` barrel: the barrel drags in
// Monaco, which vitest.config.ts stubs but which is cheaper to avoid here.
import { useTrackerContentCollab } from '../useTrackerContentCollab';
import { _resetBodyDocCacheForTests } from '../../services/BodyDocCache';
import { NimbalystEditor } from '@nimbalyst/runtime/editor/NimbalystEditor';
import type { EditorConfig } from '@nimbalyst/runtime/editor/EditorConfig';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = 'bug_test_item';
const MARKER = 'UNIQUE-BODY-MARKER';
const BODY_MARKDOWN = [
  '# Tracker body heading',
  '',
  `${MARKER} first paragraph of the shared tracker body, with **bold** and \`code\`.`,
  '',
  'A second paragraph so the room state is non-trivial.',
].join('\n');

/**
 * Mirrors TrackerItemDetail's collaborative-content wiring: same hook
 * arguments, same editor config shape, same
 * `key={`collab-${itemId}-${providerEpoch}`}` remount key.
 */
function TrackerBodyHarness(): React.ReactElement {
  const { collaboration, loading, providerEpoch } = useTrackerContentCollab({
    itemId: ITEM_ID,
    title: 'NIM-TEST',
    workspacePath: '/workspace',
    syncMode: 'shared',
    teamMemberCount: 1,
    teamOrgId: 'org-1',
    itemShared: true,
  });

  const config = useMemo((): EditorConfig | null => {
    if (!collaboration || loading) return null;
    return {
      isRichText: true,
      editable: true,
      showToolbar: false,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      collaboration: { ...collaboration },
    } as EditorConfig;
  }, [collaboration, loading]);

  if (!config) return <div data-testid="tracker-content-not-ready" />;
  return <NimbalystEditor key={`collab-${ITEM_ID}-${providerEpoch}`} config={config} />;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textIn(testId: string): string {
  const host = document.querySelector(`[data-testid="${testId}"]`);
  return host?.querySelector('[contenteditable="true"]')?.textContent ?? '<no editor>';
}

function roomBytes(): number {
  return h.rooms.get(`tracker-content/${ITEM_ID}`)?.byteLength ?? 0;
}

/** Let the hook's async acquire + React's effect flush settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

function expectPainted(testId: string, label: string): void {
  const text = textIn(testId);
  expect(
    text,
    `${label}: editor is blank.\nroom bytes: ${roomBytes()}\neditor text: ${JSON.stringify(text)}`,
  ).toContain(MARKER);
  const copies = text.split(MARKER).length - 1;
  expect(copies, `${label}: body duplicated ${copies}x (CRDT merge of seed + room)`).toBe(1);
}

// ---------------------------------------------------------------------------

describe('shared tracker body paints on reopen (NIM-1985 harness)', () => {
  beforeEach(() => {
    h.rooms.clear();
    _resetBodyDocCacheForTests();

    // jsdom lacks both; NimbalystEditor's useResponsiveWidth / Editor's
    // viewport effect need them.
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });

    (window as any).electronAPI = {
      documentService: {
        getTrackerBodyCacheForDetail: vi.fn(async () => ({
          success: true,
          row: { content: BODY_MARKDOWN },
        })),
      },
      collabBackup: { contentChanged: vi.fn(async () => undefined) },
    };
  });

  afterEach(() => {
    cleanup();
    _resetBodyDocCacheForTests();
  });

  it('close -> reopen against a warm BodyDocCache entry', async () => {
    function App({ open }: { open: boolean }) {
      return (
        <React.StrictMode>
          {open && <div data-testid="detail"><TrackerBodyHarness /></div>}
        </React.StrictMode>
      );
    }

    const app = render(<App open={true} />);
    await settle();
    expectPainted('detail', 'first open (cold cache, empty room)');
    expect(roomBytes(), 'first open should seed the room').toBeGreaterThan(100);

    app.rerender(<App open={false} />);
    await settle();
    app.rerender(<App open={true} />);
    await settle();
    expectPainted('detail', 'reopen (warm cache, populated room)');
  });

  it('React <Activity> hide/show -- how Tracker mode actually switches (App.tsx:2291)', async () => {
    function App({ visible }: { visible: boolean }) {
      return (
        <React.StrictMode>
          <Activity mode={visible ? 'visible' : 'hidden'}>
            <div data-testid="detail"><TrackerBodyHarness /></div>
          </Activity>
        </React.StrictMode>
      );
    }

    const app = render(<App visible={true} />);
    await settle();
    expectPainted('detail', 'first open');

    // Activity unmounts effects but preserves component state and refs, so
    // CollaborationPlugin's isProviderInitialized / isBindingInitialized stay
    // true across the cycle.
    for (const round of [2, 3, 4]) {
      app.rerender(<App visible={false} />);
      await settle();
      app.rerender(<App visible={true} />);
      await settle();
      expectPainted('detail', `show #${round}`);
    }
  });

  it('two consumers of one BodyDocCache entry (trackers-mode hidden + agent tab)', async () => {
    function App({ trackersVisible, tabOpen }: { trackersVisible: boolean; tabOpen: boolean }) {
      return (
        <React.StrictMode>
          <Activity mode={trackersVisible ? 'visible' : 'hidden'}>
            <div data-testid="trackers-mode"><TrackerBodyHarness /></div>
          </Activity>
          {tabOpen && <div data-testid="agent-tab"><TrackerBodyHarness /></div>}
        </React.StrictMode>
      );
    }

    const app = render(<App trackersVisible={true} tabOpen={false} />);
    await settle();
    expectPainted('trackers-mode', 'trackers mode, first open');

    app.rerender(<App trackersVisible={false} tabOpen={true} />);
    await settle();
    expectPainted('agent-tab', 'agent tab, first open (trackers hidden)');

    for (const round of [2, 3]) {
      app.rerender(<App trackersVisible={false} tabOpen={false} />);
      await settle();
      app.rerender(<App trackersVisible={false} tabOpen={true} />);
      await settle();
      expectPainted('agent-tab', `agent tab reopen #${round}`);
    }

    app.rerender(<App trackersVisible={true} tabOpen={true} />);
    await settle();
    expectPainted('trackers-mode', 'back to trackers mode');
  });

  it('reopen with NO cold-paint seed -- only the Y.Doc replay can paint', async () => {
    function App({ open }: { open: boolean }) {
      return (
        <React.StrictMode>
          {open && <div data-testid="detail"><TrackerBodyHarness /></div>}
        </React.StrictMode>
      );
    }

    const app = render(<App open={true} />);
    await settle();
    expectPainted('detail', 'first open (seeds the room)');

    app.rerender(<App open={false} />);
    await settle();

    // Drop the tracker_body_cache row: `initialEditorState` is now undefined,
    // so the connect()-time bridge replay is the ONLY possible source of text.
    (window as any).electronAPI.documentService.getTrackerBodyCacheForDetail = vi.fn(
      async () => ({ success: true, row: null }),
    );

    app.rerender(<App open={true} />);
    await settle();
    expectPainted('detail', 'reopen with no seed (Y.Doc replay only)');
  });
});
