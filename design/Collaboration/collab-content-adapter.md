---
planStatus:
  planId: collab-content-adapter
  title: CollabContentAdapter — generic shared-doc content contract
  status: in-review
  planType: system-design
  priority: high
  owner: ghinkle
  tags:
    - collaboration
    - extensions
    - yjs
    - history
    - re-upload
    - search
  created: 2026-05-26T00:00:00.000Z
  updated: 2026-05-26T03:00:00.000Z
  startDate: 2026-05-26
  progress: 100
---
# CollabContentAdapter

## Implementation Progress

- [x] Scaffold `@nimbalyst/collab-adapters` package: interface, registry, exports, build config
- [x] Extract `MarkdownCollabContentAdapter` from `CollabLocalOriginService` (toPlainText, applyFromFile, exportToFile, layoutVersion)
- [x] Refactor `reuploadFromLocalOrigin` to dispatch through `getCollabContentAdapter(documentType)`
- [x] Port `csv-spreadsheet` seed into `CsvCollabContentAdapter`
- [x] Port `excalidraw` seed into `ExcalidrawCollabContentAdapter`
- [x] Port `datamodellm` seed into `DataModelCollabContentAdapter`
- [x] Port `mockuplm` `.mockup.html` seed into `MockupHtmlCollabContentAdapter`
- [x] Port `mockuplm` `.mockupproject` seed into `MockupProjectCollabContentAdapter`
- [x] Fold `RevisionSnapshotAdapter` into the new contract (default `exportRevisionSnapshot` / `restoreRevisionSnapshot` via Y state vector)
- [x] Rewire `CollabHistoryController` to look up adapters by `documentType`
- [x] Register all built-in adapters at host startup
- [x] Add `documentSync:export-to-file` IPC handler
- [x] Typecheck and run unit tests

A first-class per-extension contract that lets platform features
(re-upload, history, export, AI editing, search indexing, comments,
backup, restore) operate on any extension's collaborative Y.Doc
without knowing its internal layout.

## Why

We're building "Google Docs, but pluggable per editor type." Today
each extension owns its own Y.Doc layout (Lexical for markdown,
Y.Text for `.mockup.html`, Y.Map-keyed entities for `.mockupproject`,
shape maps for Excalidraw, node/edge maps for Mindmap, etc.) and its
own seed code in `packages/extensions/<ext>/src/collab/seed.ts`. The
host can't reach into any of these generically.

Every platform feature that needs to read or replace shared-doc
content has hit this wall:

| Feature | What it needs |
| --- | --- |
| Re-upload from local source | Read local file bytes → replace shared Y.Doc content |
| Revision history | Snapshot Y.Doc to bytes; restore later. Partially exists. |
| Export to file | Serialize live Y.Doc to the on-disk format (`.md`, `.excalidraw`, etc.) |
| AI edit shared doc | Get plain text view; apply edits back as Y.Doc mutations |
| Search indexing | Stream plain-text or structured projection to the index |
| Comments anchored to ranges | Stable references into structured content |
| Backup / migration | Round-trip Y.Doc state across schemas and storage tiers |
| Restore from local file | Same as re-upload, triggered from history UI |
| "Save a copy to disk" | Same as export, written to a workspace path |

The current symptom: `reuploadFromLocalOrigin` in
`CollabLocalOriginService.ts` returns `{ status: 'unsupported',
message: 'Re-upload from local source currently supports markdown
shared documents only.' }` because it can only drive
`HeadlessLexicalYDoc`. That's just the first feature to hit the
generalisation problem; every feature above will hit the same wall.

## Current state

Two adjacent contracts already exist; CollabContentAdapter
generalises them.

### `RevisionSnapshotAdapter` (already in runtime)

Custom collaborative editors register a per-tab adapter:

```ts
interface RevisionSnapshotAdapter {
  contentFormat: string;           // 'markdown' | 'excalidraw' | ...
  previewKind: 'text' | 'metadata-only' | ...;
  exportRevisionSnapshot(): Uint8Array;
  restoreRevisionSnapshot(bytes: Uint8Array): void;
}
```

This is wired into `CollabHistoryController` and used by the
History dialog. It's the existence proof for "every extension can
hand the host bytes" and "the host can ask it to restore bytes."
But it's:

- per-tab (created when an editor mounts), not per-extension
- limited to one operation pair (snapshot/restore)
- not reachable from main process or worker
- not declared by the extension manifest

### Per-extension `seed.ts` modules

Each extension exports `seedXYZ(yDoc, content)` that runs only when
the Y.Doc is empty (initial-share flow). Lives in renderer-loadable
extension packages. Can't be called by main, the Worker, or another
extension. No corresponding "wipe" or "reseed" operation.

## Proposed contract

```ts
interface CollabContentAdapter<TPlain = string> {
  /** Identifies this adapter; matches the shared doc's documentType. */
  documentType: string;

  /** File extensions this adapter is the on-disk codec for. */
  fileExtensions: string[];
  mimeType?: string;

  /** Whether the Y.Doc has any content yet (used to gate initial seed). */
  isEmpty(yDoc: Y.Doc): boolean;

  /** Seed an empty Y.Doc from on-disk file bytes/text. Initial share. */
  seedFromFile(yDoc: Y.Doc, source: string | Uint8Array): void;

  /**
   * Replace Y.Doc content with the supplied on-disk file content.
   * Must be safe to call on a populated Y.Doc. Default behaviour is
   * wipe-and-reseed inside a single Y.Doc transaction, so other
   * clients observe one CRDT step. Adapters that want finer-grained
   * history (mockup project, mindmap) can override this with a
   * diff-and-patch implementation; markdown and Y.Text-shaped
   * adapters stick with the default.
   */
  applyFromFile(yDoc: Y.Doc, source: string | Uint8Array): void;

  /** Layout schema version. Bump when the Y.Doc shape changes. */
  layoutVersion: number;

  /**
   * Optional migrations from older layout versions. Run by the
   * registry before applyFromFile / applyStructuredPatch when the
   * Y.Doc's recorded layoutVersion is older than this adapter's.
   */
  migrations?: Array<{ from: number; to: number; run(yDoc: Y.Doc): void }>;

  /** Serialize the live Y.Doc back to the on-disk file format. */
  exportToFile(yDoc: Y.Doc): string | Uint8Array;

  /** Plain-text projection for search, AI prompts, diffs, history previews. */
  toPlainText(yDoc: Y.Doc): string;

  /**
   * Optional: a structured projection used by features that need more
   * than text (comments anchored to selectors, AI tool-call edits).
   * Shape is extension-defined.
   */
  toStructured?(yDoc: Y.Doc): TPlain;

  /** Optional: write structured edits back. Paired with toStructured. */
  applyStructuredPatch?(yDoc: Y.Doc, patch: unknown): void;
}
```

Snapshot/restore folds in:

```ts
// Default implementations live in the SDK; extensions override if
// they need a denser snapshot format than Y.Doc state vector.
exportRevisionSnapshot(yDoc)  → Y.encodeStateAsUpdateV2(yDoc)
restoreRevisionSnapshot(yDoc, bytes) → Y.applyUpdateV2(yDoc, bytes)
```

`RevisionSnapshotAdapter` becomes a thin facade over
`CollabContentAdapter` (or is deleted in favour of it).

## Where it lives

A new package `@nimbalyst/collab-adapters` that is importable from:

- main process (`packages/electron/src/main/...`)
- renderer (`packages/electron/src/renderer/...`)
- extension SDK (`packages/extension-sdk`) — for re-export to extensions

**Not** loaded in the collab Worker. Worker stays
adapter-agnostic and treats all Y.Doc state as opaque blobs (see
decision 4). Server-side search indexing and snapshot rollups are
explicitly out of scope for v1.

It contains:

- the `CollabContentAdapter` interface
- a `registerCollabContentAdapter(adapter)` runtime registry keyed
  on `documentType` (one adapter per documentType; extensions that
  ship multiple types like Mockup register multiple adapters)
- the canonical markdown adapter (extracted from existing Lexical
  headless code)
- adapters for built-in extensions (`mockup.html`, `mockupproject`,
  `excalidraw`, `mindmap`, `csv`), each pulled from its existing
  `seed.ts`

Third-party extensions register by exporting an adapter from their
collaboration contribution; the host walks `customEditorRegistry`
on startup and registers each one.

## Use-case dispatch

### Re-upload from local source (the immediate driver)

`CollabLocalOriginService.reuploadFromLocalOrigin`:

```ts
const adapter = collabContentAdapters.get(binding.documentType);
if (!adapter) return { status: 'unsupported', ... };

const sourceBytes = await fs.readFile(binding.resolvedPath);
const currentText = adapter.toPlainText(headlessYDoc);
const newText     = adapter.toPlainText(seedScratch(sourceBytes));
// hash compare → conflict gate identical to today's markdown path
adapter.applyFromFile(headlessYDoc, sourceBytes);
await provider.waitForPendingWrites(5000);
```

No more `documentType !== 'markdown'` short-circuit.

### History

`CollabHistoryController` calls
`adapter.exportRevisionSnapshot(yDoc)` and
`adapter.restoreRevisionSnapshot(yDoc, bytes)` directly. The
per-tab `RevisionSnapshotAdapter` registration goes away — the host
looks up the adapter by documentType at the moment it needs one.

### Export

A new `documentSync:export-to-file` IPC handler:

```ts
const adapter = collabContentAdapters.get(documentType);
const bytes = adapter.exportToFile(yDoc);
await dialog.showSaveDialog({ defaultPath: name + adapter.fileExtensions[0] });
await fs.writeFile(target, bytes);
```

Works for every type the moment its adapter is registered.

### AI editing across all shared doc types

The AI tools that today only edit markdown files get a parallel
path for shared docs: `getSharedDocPlainText(documentId)` →
`applySharedDocPatch(documentId, patch)`, both delegating to the
adapter's `toPlainText` / `applyStructuredPatch`.

### Server-side snapshot rollup / search indexing

**Deferred.** The Worker stays adapter-agnostic for v1 — all
Y.Doc state on the server is treated as opaque blobs. Search,
server-side AI, and snapshot rollups happen client-side or not at
all until we have a real reason to push adapters into the Worker
bundle.

### Backup / restore

Same `applyFromFile` path. The "Restore from local file" action in
the History dialog reuses re-upload's plumbing.

## Migration

1. **Extract** the markdown adapter from
   `CollabLocalOriginService`'s `withHeadlessMarkdownDocument` and
   `readSharedMarkdown` / `overwriteSharedMarkdown` into a
   `MarkdownCollabContentAdapter` in `@nimbalyst/collab-adapters`.
2. **Refactor** `reuploadFromLocalOrigin` to look up the adapter by
   `binding.documentType` and dispatch. Markdown behaviour
   unchanged; non-markdown returns `unsupported` only when no
   adapter is registered.
3. **Port** the existing seed functions (`seedMockupYDoc`,
   `seedMockupProjectYDoc`, Excalidraw, Mindmap, CSV) into adapters
   that live next to them in their extension packages, register
   themselves on extension activation, and additionally expose
   `applyFromFile`, `exportToFile`, `toPlainText`.
4. **Fold** `RevisionSnapshotAdapter` into the new contract; update
   `ExtensionCollabBranch` to register the document-type-scoped
   adapter on mount instead of a per-tab snapshot adapter.
5. **Reach** the adapter registry from main and Worker contexts so
   features beyond re-upload can use it without renderer round-trips.

## Security & trust boundary

The adapter contract preserves the existing end-to-end encryption
model. The collab Worker never sees plaintext Y.Doc state today,
and nothing in this design changes that.

### Where adapters run

Adapters are client-only code, loaded in main process, renderer,
and the extension SDK. They are explicitly **not** loaded in the
collab Worker (decision 4). The Worker continues to handle Y.Doc
state as opaque ciphertext blobs encrypted with the team's
AES-256-GCM org key. An adapter cannot project, read, or modify
shared content on the server because the server has no adapter
code and no key.

### What each operation does to plaintext

| Operation | Where it runs | New plaintext exposure |
| --- | --- | --- |
| `seedFromFile` / `applyFromFile` | Client in-memory on a Y.Doc the client already decrypted | None. Resulting updates flow out through `DocumentSyncProvider` → AES-256-GCM → opaque blobs on the Worker, same as every other client write. |
| `exportToFile` | Client memory → local disk via existing save flow | None server-side. Equivalent to "save a copy" today. |
| `toPlainText` / `toStructured` | Pure in-memory projection | None on its own. **Consumer-dependent** — see "AI boundary" below. |
| `exportRevisionSnapshot` / `restoreRevisionSnapshot` | Client memory; bytes travel through the same encrypted channel | None. Snapshot bytes are themselves part of the encrypted update stream. |

### Key handling

Adapters never touch keys. They receive a `Y.Doc` that is already
a decrypted client view. The org key, JWT, and the
`DocumentSyncProvider` encrypt/decrypt path are unchanged.
Adapters do not introduce a new key-distribution surface.

### AI boundary

`toPlainText` makes AI-on-shared-docs an obvious next feature.
AI calls egress plaintext to whatever AI provider the user has
configured (Anthropic, OpenAI, local LM Studio, etc.). That is the
same trust boundary as AI-on-local-files today; **it is not a
regression of collab end-to-end encryption** because the
encryption guarantee only ever covered "no plaintext on the
Nimbalyst collab servers." It did not, and does not, cover content
the user themselves sends to an external AI provider.

When AI-on-shared-docs ships, the UI must surface that boundary
exactly the same way AI-on-local-files does (provider name,
egress confirmation if the org has that policy enabled). The
adapter contract itself is silent on this — it just hands back
plaintext to whoever asked.

### Asset uploads

Re-upload from a local source can pull in attached images (existing
markdown migration flow at `migrateMarkdownAssetsForCollab`). Those
assets continue to flow through `encryptAndUploadCollabAsset`,
which AES-encrypts each asset with the org key before it ever
hits the asset-storage path. Adapters that handle binary
attachments (Excalidraw embedded images, etc.) reuse the same
encrypted-asset pipeline; they do not introduce a parallel upload
path.

### Third-party adapters

A malicious third-party adapter running in the client could leak
plaintext anywhere a renderer can reach (HTTP, postMessage). This
is the same threat surface as any other extension renderer code
and is governed by the existing extension permission model
(`docs/EXTENSION_ARCHITECTURE.md`, backend-module allowlist,
catalog permissions). The adapter contract does not enlarge that
surface; the extension already had `Y.Doc` access via its
existing collaboration hooks.

## Out of scope (named so we don't accidentally pull them in)

- Comments / anchored discussions — needs anchors-into-structured
  content; will lean on `toStructured` once defined.
- Notifications / change feed — orthogonal to content shape.
- Online/offline merge UI — DocumentSyncProvider already owns that.

## Decisions (2026-05-26)

1. **Registry key: `documentType`.** One adapter per documentType.
   Extensions that ship multiple types (Mockup with `.mockup.html`
   and `.mockupproject`) register multiple adapters.
2. **applyFromFile mode: per-adapter, default wipe-and-reseed.**
   Adapters override with a diff-and-patch implementation when
   finer-grained history is worth the per-adapter complexity
   (likely candidates: mockup project, mindmap). Markdown and
   simple Y.Text adapters stay on the default.
3. **AI editing on visual editors: require `toStructured` for
   AI-write.** AI-read works on every adapter via `toPlainText`
   (lossy is fine for prompts). AI-write is only enabled on
   adapters that implement `toStructured` + `applyStructuredPatch`.
   Visual-only adapters that skip the structured surface remain
   read-only to AI.
4. **Worker-side adapters: not loaded.** Worker stays
   adapter-agnostic; all Y.Doc state on the server is opaque.
   Server-side search indexing and snapshot rollups are deferred
   until we have a use case that justifies pushing adapters into
   the Worker bundle.
5. **`layoutVersion` + migrations: yes.** Every adapter declares
   `layoutVersion: number`. Mismatches on `applyFromFile` /
   `applyStructuredPatch` run registered migrations before the
   adapter touches the doc. Mockup project's existing
   `meta.version` becomes the first concrete example.
