# Collaboration Guide for Extension Editors

How to add real-time collaboration ("Share to Team") to a Nimbalyst extension editor.

## What you get from the host

The host owns the entire transport stack:

- **`DocumentRoom` Durable Object** — encrypted update relay on Cloudflare Workers.
- **`DocumentSyncProvider`** (`packages/runtime/src/sync/DocumentSync.ts`) — Y.Doc + AES-256-GCM + WebSocket + offline queue + reconnection + snapshot compaction.
- **Connection status bar, collaborator avatars, key-rotation handling** — implemented once in `CollaborativeTabEditor` for every collab editor type.

What your extension implements is small: a yJS binding that maps your editor's internal state to/from a shared `Y.Doc`, plus a deterministic seed routine for first-open.

## Files you touch

```
packages/extensions/your-editor/
  manifest.json                              -- add `collaboration.supported: true`
  package.json                               -- add `yjs`, `y-protocols` peerDeps
  vite.config.ts                             -- add `yjs`, `y-protocols` to externals
  src/collab/yourBinding.ts                  -- new -- the binding class
  src/collab/seed.ts                         -- new -- deterministic Y.Doc bootstrap
  src/components/YourEditor.tsx              -- call `useCollaborativeEditor`
```

## Step 1: Manifest

```json
{
  "contributions": {
    "customEditors": [{
      "filePatterns": ["*.yourext"],
      "displayName": "Your Editor",
      "component": "YourEditor",
      "collaboration": {
        "supported": true,
        "awarenessFields": ["pointer", "selection", "editingNodeId"]
      }
    }]
  }
}
```

`awarenessFields` is advisory — list the extra keys (beyond the standard `user`, `pointer`, `selection`) your editor publishes via awareness. It does not gate runtime behaviour.

## Step 2: Package + bundler config

```json
// package.json
{
  "dependencies": { "fractional-indexing": "^3.2.0" },
  "devDependencies": { "yjs": ">=13.5.42", "y-protocols": "^1.0.5" },
  "peerDependencies": { "yjs": ">=13.5.42", "y-protocols": "^1.0.5" }
}
```

```typescript
// vite.config.ts
rollupOptions: {
  external: [
    'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime',
    'yjs',
    /^y-protocols(\/.*)?$/,
    // ... existing externals
  ],
}
```

**Why this matters:** the host shares a single yjs instance with every extension via an es-module-shims import map. If your extension bundles its own copy, `instanceof Y.Doc` checks fail across the host-extension boundary (same constraint as React).

## Step 3: Choose your Y.Doc shape

There is no single "right" shape — pick the structure that maps cleanly to your editor's internal state model. Three patterns work well:

### Pattern A: ordered list of items (Excalidraw)

```
Y.Doc
├── elements: Y.Array<Y.Map>
│     each element: { el: ExcalidrawElement, pos: string /* fractional index */ }
├── assets: Y.Map<string, BinaryFileData>
└── appState: Y.Map<string, unknown>
```

The Y.Array is treated as an unordered bag; ordering is driven by the `pos` fractional-index string. This avoids Y.Array's lack of a move operation (concurrent reorders would duplicate elements). See `packages/extensions/excalidraw/src/collab/` for the full reference implementation.

### Pattern B: keyed entities + ordered children (Mindmap)

```
Y.Doc
├── nodes: Y.Map<nodeId, Y.Map>
│     each value: { text, note, parentId, color, status, ...,
│                   childIds: Y.Array<string>, tags: Y.Array<string> }
└── meta: Y.Map { title, version, rootId }
```

`childIds` is a `Y.Array<string>` per node so concurrent child reorders converge naturally. `tags` likewise as `Y.Array<string>` so concurrent tag-add operations don't clobber each other.

Binding pattern: a reducer-side translation layer. Local reducer actions map to Y.Map/Y.Array mutations; remote observations on `nodes`/`meta` map back to reducer dispatches. Use transaction origin to prevent feedback loops:

```typescript
class MindmapBinding {
  constructor(yDoc: Y.Doc, store: MindmapStore, awareness: Awareness) {
    const yNodes = yDoc.getMap<Y.Map<unknown>>('nodes');
    const yMeta = yDoc.getMap<unknown>('meta');

    // Local store -> Y.Doc
    store.subscribe((action) => {
      if (action.source === 'remote') return;
      yDoc.transact(() => this.applyAction(action, yNodes, yMeta), this);
    });

    // Y.Doc -> local store
    yNodes.observeDeep((events, txn) => {
      if (txn.origin === this) return;
      const actions = this.deriveActionsFromYEvents(events, yNodes);
      for (const a of actions) store.dispatch({ ...a, source: 'remote' });
    });
  }
}
```

Awareness for Mindmap typically carries `editingNodeId` so the editor can render a "X is editing this node" indicator alongside avatars.

### Pattern C: rich text (Lexical / TipTap / ProseMirror)

Use the editor library's official yJS binding (`@lexical/yjs`, `y-prosemirror`, etc.). The Lexical / markdown path in Nimbalyst is special-cased through `CollabLexicalProvider` and does NOT go through `useCollaborativeEditor` — it has its own production-tested wiring. If you're shipping a new rich-text editor, write a similar adapter rather than reinventing the rich-text-on-CRDT problem.

## Step 4: The binding class

The binding class wires local edits into Y.Doc and remote Y.Doc changes back into the editor.

```typescript
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export class YourBinding {
  private subscriptions: Array<() => void> = [];

  constructor(
    private yElements: Y.Array<Y.Map<unknown>>,
    private editorApi: YourEditorAPI,
    private awareness?: Awareness,
  ) {
    // Local -> Y.Doc (typically debounced 20-100ms)
    this.subscriptions.push(
      editorApi.onChange(debounce((next) => {
        const ops = computeDelta(this.lastKnownState, next);
        yElements.doc!.transact(() => applyOps(yElements, ops), this);
        this.lastKnownState = next;
      }, 50)),
    );

    // Y.Doc -> Editor
    const onRemote = (events: Y.YEvent[], txn: Y.Transaction) => {
      if (txn.origin === this) return; // ignore our own writes
      editorApi.applyState(projectYDocToEditorState(yElements));
    };
    yElements.observeDeep(onRemote);
    this.subscriptions.push(() => yElements.unobserveDeep(onRemote));

    // Awareness (cursor, selection, custom fields)
    if (awareness) {
      const onAwareness = () => this.updateCollaboratorsFromAwareness();
      awareness.on('change', onAwareness);
      this.subscriptions.push(() => awareness.off('change', onAwareness));
    }
  }

  destroy() {
    for (const s of this.subscriptions) s();
    this.subscriptions = [];
  }
}
```

### Transaction origin

ALWAYS pass `this` (the binding instance) as the second argument to `yDoc.transact()` for local writes. The remote-observer guard `if (txn.origin === this) return` is what prevents a feedback loop where your local write triggers your remote handler which triggers another local write.

### Seeding origin

When the SDK hook calls `initializeFromContent`, it wraps your call in `yDoc.transact(..., COLLAB_INIT_ORIGIN)`. If your binding's remote-change observer fires during seeding (you registered it before the seed ran, or the seed happens after binding for a non-empty doc), check the origin:

```typescript
import { COLLAB_INIT_ORIGIN } from '@nimbalyst/extension-sdk';

const onRemote = (events, txn) => {
  if (txn.origin === this) return;
  if (txn.origin === COLLAB_INIT_ORIGIN) return;
  // ... apply remote change
};
```

## Step 5: Deterministic seed

When this client is the first to open a collab document, the hook calls `initializeFromContent(yDoc, fileContent)`. Two clients can race here — both see an empty Y.Doc, both call seed, both produce CRDT updates. Their updates merge. Without determinism, both copies of every element land in the merged doc.

**Rule:** seed using content-derived stable IDs only. Never call `Math.random()` or `crypto.randomUUID()` inside the seed.

```typescript
// GOOD: uses element.id from the file, deterministic fractional keys
export function seedYDoc(yDoc: Y.Doc, content: string) {
  const file = JSON.parse(content);
  const yElements = yDoc.getArray('elements');
  const keys = generateNKeysBetween(null, null, file.elements.length);
  for (let i = 0; i < file.elements.length; i++) {
    const m = new Y.Map();
    m.set('el', file.elements[i]);       // file.elements[i].id is stable
    m.set('pos', keys[i]);                // generateNKeysBetween is deterministic for n
    yElements.push([m]);
  }
}

// BAD: random ids drift between concurrent seeds
export function badSeed(yDoc: Y.Doc, content: string) {
  for (const el of JSON.parse(content).elements) {
    const m = new Y.Map();
    m.set('el', { ...el, id: crypto.randomUUID() }); // <-- different on each client
    yElements.push([m]);
  }
}
```

Also provide an `isEmpty` callback so the hook doesn't re-seed a doc that was just sync'd in:

```typescript
export function isMyDocEmpty(yDoc: Y.Doc): boolean {
  return yDoc.getArray('elements').length === 0;
}
```

The default `isEmpty` checks `Y.encodeStateAsUpdate(yDoc).byteLength <= 2` — which is conservative and works for most cases, but will return `true` even when shared types exist as empty containers. If your binding always creates a `Y.Map('meta')` even on first open, the byte-length check fires when there's no real content; supplying a custom `isEmpty` avoids the false negative.

## Step 6: Awareness

The host provides a y-protocols `Awareness` instance on `host.collaboration.awareness`. Standard fields (rendered generically by the host as avatars and cursors):

```typescript
interface StandardAwarenessState {
  user: { id: string; name: string; color: string };
  pointer?: { x: number; y: number };
  selection?: unknown;
  [k: string]: unknown;   // your extras
}
```

The host pre-populates `user` on the local state before the binding ever runs. You add per-editor extras directly via `awareness.setLocalStateField`:

```typescript
// Excalidraw: selected element IDs + pointer (Excalidraw's `onPointerUpdate`)
awareness.setLocalStateField('selectedElementIds', state.selectedElementIds);
awareness.setLocalStateField('pointer', { x, y, tool: 'pointer' });

// Mindmap: which node is being edited
awareness.setLocalStateField('editingNodeId', editingId);
```

Remote presence comes via the standard `change` event:

```typescript
awareness.on('change', ({ added, updated, removed }) => {
  const states = awareness.getStates(); // Map<clientID, state>
  // ... render your collaborator overlays
});
```

The host runs awareness updates through DocumentSync's encrypted broadcast at ~2 Hz (throttled). For very high-frequency events (mouse drags), Excalidraw's `onPointerUpdate` is already debounced inside the binding via `awareness.setLocalStateField` -> DocumentSync throttle.

## Step 7: Undo / redo

In local-only mode your editor probably has its own undo/redo stack. In collab mode, that stack would step out from under remote changes — undoing a local move would also clobber a remote teammate's edit if it happened between your move and your undo.

The fix is `Y.UndoManager`, which tracks only operations tagged with a specific origin (your binding). Hijack your editor's undo/redo to route through it:

```typescript
const undoManager = new Y.UndoManager(yElements, {
  trackedOrigins: new Set([binding]),  // your binding instance
});

// Replace local handlers
editorApi.setUndoHandler(() => undoManager.undo());
editorApi.setRedoHandler(() => undoManager.redo());
```

Only do this in collab mode (gate on `host.collaboration` presence). In local-only mode the editor's built-in undo is correct.

## Step 8: Wire the hook

```typescript
import { useCollaborativeEditor, COLLAB_INIT_ORIGIN } from '@nimbalyst/extension-sdk';
import * as Y from 'yjs';

function YourEditor({ host }: EditorHostProps) {
  // Existing local-only lifecycle stays unchanged.
  const { markDirty, isLoading, theme } = useEditorLifecycle(host, {
    applyContent, getCurrentContent, parse, serialize,
  });

  // No-op when host.collaboration is undefined.
  const { isCollaborative, status, collaborators } = useCollaborativeEditor(host, {
    isEmpty: isYourDocEmpty,
    initializeFromContent: seedYourDoc,
    createBinding: ({ yDoc, awareness, user }) => {
      const binding = new YourBinding(
        yDoc.getArray('elements'),
        editorApiRef.current!,
        awareness,
      );
      return { destroy: () => binding.destroy() };
    },
  });

  return <YourCanvas ... />;
}
```

`isCollaborative` is `true` exactly when `host.collaboration` is defined. `status` and `collaborators` are reactive React state — re-render your collaborator overlay or status indicator off of them as needed (or rely on the host's status bar in `CollaborativeTabEditor` and skip rendering your own).

## Step 9: Manual verification (two-instance test)

Until the automated multi-instance Playwright test lands, verify by running two isolated dev instances:

```bash
# Terminal 1 — primary instance
cd packages/electron && npm run dev

# Terminal 2 — second isolated instance
cd packages/electron && npm run dev:user2
```

Sign in as different team members in each. Share a `.yourext` file from instance A. Open it from the Collab Mode sidebar in instance B. Verify:

1. Edits in A appear in B within ~200ms (and vice versa).
2. Cursors / selection from the other client render.
3. Undo / redo only touches your own operations.
4. Disconnect one instance, edit offline, reconnect — your offline edits replay and merge with anything the other instance did meanwhile.
5. Close both instances. Reopen the doc. Initial sync is fast (snapshot compaction kicks in after ~200 updates accumulate; verify in renderer logs with the `[DocumentSync] Sent docCompact` message).

## Known constraints

- **Asset / image embeds.** Excalidraw's image blobs are intentionally not migrated through the collab-asset upload pipeline at this point. Local refs (`assets/<hash>.png`) sync through Y.Doc as base64 strings, which works but bloats updates. The markdown path uses `CollabAssetService` for proper S3-backed asset storage; a future round will generalise that for binary editor formats.

- **History.** `host.openHistory()` is a no-op for non-markdown collab documents. The two-tier history (file snapshots + Lexical-aware diffs) is markdown-only today.

- **Mobile viewer.** The shared file viewer at `share.nimbalyst.com` renders extension formats as static snapshots, not real-time. Collaborative edits land for collaborators in-app; viewer URLs refresh on the next snapshot.

- **Review gate.** The `host.collaboration` surface does not yet expose review-gate hooks for non-markdown editors. The transport-level review gate (block autosave until accept) is in place, but extensions can't yet render per-element "remote change pending" overlays. An optional `onReviewGateChange` SDK callback is planned but not in this round.

## Reference implementation

`packages/extensions/excalidraw/src/collab/` ships the complete reference:

- `excalidrawBindings.ts` — full ExcalidrawBinding class, including duplicate-id recovery, ordering-key regeneration, and undo/redo hijack.
- `excalidrawDiff.ts` — delta computation between two element arrays and operation application onto the Y.Array<Y.Map> structure.
- `excalidrawHelpers.ts` — small helpers (debounce, sort, deep-equal-on-version).
- `seed.ts` — deterministic seed from an `.excalidraw` JSON file.
