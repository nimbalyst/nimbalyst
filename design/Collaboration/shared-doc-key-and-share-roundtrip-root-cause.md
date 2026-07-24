# Shared-doc key + share-roundtrip root cause analysis

Status: investigation only — no code changes
Date: 2026-05-22
Scope: Symptoms reported in the parent session "Fix shared docs disappearing and offline sync issues"

The parent session's user-facing fixes (loading state, auto-expand folders, calling `api.updateScene` from the Excalidraw binding constructor) are necessary but not sufficient. Two underlying bugs remain.

---

## Symptom 1 — share an Excalidraw, close, reopen → blank canvas

### Where the breakage sits

The residual failure is a race between Excalidraw's imperative-API callback and the SDK collab hook's `createBinding` call **on the reopen path**. The seed almost always reaches the server (see "Why the seed normally reaches the server" below); the canvas is blank on reopen because the binding never gets constructed.

### Exact sequence

On reopen of a previously-shared `.excalidraw`:

1. `CollaborativeTabEditor` mounts. `useEffect` at `packages/electron/src/renderer/components/TabEditor/CollaborativeTabEditor.tsx:254-342` creates `DocumentSyncProvider` (status='disconnected') but does **not** call `connect()`.
2. `ExtensionCollabBranch` mounts. Its `useEffect` at `CollaborativeTabEditor.tsx:690-697` calls `syncProvider.connect()`.
3. `ExcalidrawEditor` (the extension component) renders. `useEditorLifecycle` calls `host.loadContent()` which, in collab mode, returns `activeConfig.initialContent ?? ''` synchronously (`collabExtensionHost.ts:306-308`). `setIsLoading(false)` fires after the microtask hop (`packages/extension-sdk/src/useEditorLifecycle.ts:284-292`).
4. ExcalidrawEditor re-renders with `isLoading=false`. The `<Excalidraw>` element mounts. Excalidraw internally initialises and calls the `excalidrawAPI` ref-callback (`ExcalidrawEditor.tsx:353-356`), populating `excalidrawAPIRef.current`. **This is asynchronous relative to React's commit phase** — it depends on Excalidraw's internal effects.
5. In parallel: `DocumentSync` does its WS handshake → server returns a `docSyncResponse` carrying the snapshot + updates. `handleSyncResponse` decrypts and applies them (`packages/runtime/src/sync/DocumentSync.ts:639-723`). Because the room has content, this populates the Y.Doc's `elements` array. At line 696 it sets `synced=true`; at line 711 it sets status='connected'; this synchronously fires `config.onStatusChange?.('connected')` → `notifyCollabStatus` → `statusFanout.emit` (`collabExtensionHost.ts:229-234`).
6. The fan-out invokes the SDK hook's status listener, which does `void tryStart()` (`packages/extension-sdk/src/useCollaborativeEditor.ts:228-229`).
7. `tryStart` (lines 186-225): status check passes. `isEmptyFn(collab.yDoc)` returns FALSE because sync brought content. **The entire seed branch (lines 193-216) is skipped.** Execution jumps to line 218-224:
   ```ts
   if (cancelled) return;
   handle = cfg.createBinding({ yDoc, awareness, user });
   setBinding(handle);
   ```
8. `createBinding` runs (`ExcalidrawEditor.tsx:247-274`). It reads `excalidrawAPIRef.current`. If steps 4 and 5 raced and step 5 won, **the ref is still null**:
   ```ts
   createBinding: ({ yDoc, awareness }) => {
     const api = excalidrawAPIRef.current;
     if (!api) {
       return { destroy: () => {} };   // ← canvas never bound
     }
     // ...
   }
   ```
9. The no-op handle is stored. `tryStart`'s early-return at line 187 (`if (cancelled || handle) return;`) means later status-change callbacks will not retry. The hook's deps are `[host]` (line 241), so refs flipping doesn't re-fire the effect either. The binding is never constructed, so the parent session's `api.updateScene(syncedElements)` patch at `excalidrawBindings.ts:273-313` is never reached. **Blank canvas.**

### Why share itself succeeds (and reopen does not)

On the first share, `isEmpty(collab.yDoc)` is TRUE (server empty, Y.Doc empty). `tryStart` takes the seed branch:

- `await collab.loadInitialContent()` — sync, returns the JSON string from `activeConfig.initialContent`.
- `yDoc.transact(() => initializeFromContent(yDoc, content), COLLAB_INIT_ORIGIN)` — populates yElements/yAssets/yAppState (`seed.ts:47-81`).
- `await collab.flushLocalState()` — internally awaits `encryptBinary` (async) and the WS `send` (sync after encrypt).

That async chain happens to give Excalidraw time to finish its internal init and set `excalidrawAPIRef.current` before `createBinding` runs. On reopen the whole seed branch is skipped, so `createBinding` runs sooner and loses the race.

### Why the seed normally reaches the server

Reading `DocumentSync.ts:639-723`:

- After `synced=true`, with no `hasPendingLocalUpdates()`, the code does `setStatus('connected')` then `await pushLocalState(msg)`. `pushLocalState` (lines 862-878) only sends if `serverHasNoState` AND the local Y.Doc has content. At this moment the hook hasn't seeded yet, so Y.Doc is empty and `pushLocalState` returns early. It is effectively a no-op for first-share.
- The seed actually reaches the server via the local-update observer: when the hook calls `yDoc.transact(() => initializeFromContent(...), COLLAB_INIT_ORIGIN)`, the observer at `DocumentSync.ts:793-813` fires with origin = `COLLAB_INIT_ORIGIN` (not in the filtered list at line 798-802), `enqueuePendingLocalUpdate(update)` runs, and `await this.replayPendingUpdate()` sends it.
- `flushLocalState` (lines 466-473) follows up by encoding the full state and enqueueing again — usually a no-op merge in this flow, but it's a safety net if the observer didn't fire (e.g., if seeding produced no diff).

If the user closes the tab very fast (before the WS `send` completes), `disconnect()` calls `requeueInflightPendingUpdate` (lines 1028-1041) which moves the in-flight bytes back into `queuedPendingUpdate` and `schedulePendingPersist`; `destroy()` then calls `flushPendingPersistImmediately` (lines 975-985), which fires the IPC to persist the pending update to electron-store. On the next open, `initialPendingUpdateBase64` (lines 211-224) restores it and the post-sync `replayPendingUpdate` (line 709) flushes it to the server. So the seed normally survives, even with a fast close.

### Secondary concern (not the root cause, but flagged)

`replayPendingUpdate` (lines 880-941) consumes `queuedPendingUpdate` and assigns `inflightPendingUpdate` **before** the `await encryptBinary` call, but sets `replayingClientUpdateId` **after** it. During that gap, the guard at line 881 is still false. If a second call slips in (e.g., the hook's `flushLocalState` while the observer's earlier `replayPendingUpdate` is still in its encryption await), the second call also consumes the (now-rebuilt) queue and overwrites `inflightPendingUpdate`. For the share flow both updates happen to be the same content (seed = full state) so the symptom is masked. In other flows (e.g., a local edit racing with an ack from the server) this could orphan an update.

### Minimal fix sketch

The root issue is `ExcalidrawEditor`'s `createBinding` no-op fallback when the API ref is null, combined with the SDK hook's "fire once" semantics. Two options:

**Option A (extension-side, smallest blast radius):** In `ExcalidrawEditor.tsx:247-274`, replace the silent no-op with a deferred build. Keep a `pendingBindingFnRef` and, when `excalidrawAPI` callback fires with a non-null api, invoke the deferred builder:

```tsx
const pendingBuilderRef = useRef<((api: ExcalidrawImperativeAPI) => void) | null>(null);

createBinding: ({ yDoc, awareness }) => {
  const buildOnce = (api: ExcalidrawImperativeAPI): { destroy: () => void } => {
    const undoManager = new Y.UndoManager(yDoc.getArray('elements'));
    const binding = new ExcalidrawBinding(/* ... */);
    bindingRef.current = binding;
    return { destroy: () => { binding.destroy(); undoManager.destroy(); bindingRef.current = null; } };
  };
  const api = excalidrawAPIRef.current;
  if (api) return buildOnce(api);
  let live: { destroy: () => void } | null = null;
  pendingBuilderRef.current = (readyApi) => {
    live = buildOnce(readyApi);
  };
  return { destroy: () => { live?.destroy(); pendingBuilderRef.current = null; } };
},
```

Then in the `excalidrawAPI` callback:
```tsx
excalidrawAPI={(api) => {
  excalidrawAPIRef.current = api;
  if (api) {
    host.registerEditorAPI(createWrappedAPI(api));
    if (pendingBuilderRef.current) {
      pendingBuilderRef.current(api);
      pendingBuilderRef.current = null;
    }
  }
}}
```

**Option B (SDK-side, fixes the class of bug for all extensions):** make `useCollaborativeEditor`'s `tryStart` retry-aware. Instead of treating the first non-null `createBinding` return as final, allow extensions to return `{ destroy, defer: true }` meaning "I'm not ready; call me again on next status change". Or add a `host.collaboration.onReady(cb)` slot that extensions can use to gate binding.

Option A is the smaller, safer change.

---

## Symptom 2 — "some docs say offline" / mixed encryption-success across docs

### Where the breakage sits

After an org key rotation, the client uses a single current key and never falls back to historical keys. Any doc whose ciphertext on the server was not re-encrypted to the new key during rotation becomes permanently undecryptable for that client.

### Conditions under which `decryptTitle` / `decryptBinary` fail

`TeamSync.decryptEntry` (`packages/runtime/src/sync/TeamSync.ts:483-493`) calls `decryptTitle(encryptedTitle, titleIv, this.config.encryptionKey)`. `decryptTitle` (`TeamSync.ts:82-95`) uses only that single `CryptoKey`. There is no fallback. If the ciphertext was encrypted with a previous key generation, `crypto.subtle.decrypt` throws `OperationError`, caught by `decryptDocuments` (lines 455-481), and the entry becomes a `decryptFailed: true` placeholder (the parent session's Option-B surfacing).

Same story for document content: `DocumentSync.handleSyncResponse` (lines 646-660 for snapshots, 666-682 for updates) and `handleUpdateBroadcast` (lines 731-748) all call `decryptBinary(..., this.config.documentKey)`. The `documentKey` is just the org key — there's a single value per provider, fixed at construction (`DocumentSyncHandlers.ts:159-160`, returned to renderer as `orgKeyBase64`). No fallback to archived keys.

The OrgKeyService HAS a key history (`packages/electron/src/main/services/OrgKeyService.ts:62-65,280-336`) with `getArchivedOrgKeyByFingerprint` and `getArchivedOrgKeys` exposed, but a project-wide grep shows **no caller**:

```
$ grep -r getArchivedOrgKeyByFingerprint
packages/electron/src/main/services/OrgKeyService.ts:320: export async function getArchivedOrgKeyByFingerprint(...)
```

So the archive exists but never gets consulted.

### How docs end up with mismatched key generations

The intended design (`KeyRotationService.performKeyRotation`, `packages/electron/src/main/services/KeyRotationService.ts:903+`) is:

1. Archive current org key.
2. Set rotation-lock write barrier on every room (lines 947-964).
3. Download + decrypt the team's doc index, every document's snapshot+updates, every tracker item, every asset — all with the OLD key.
4. Generate new key, re-encrypt everything, upload with new key.
5. Lift barrier; distribute new key envelopes to remaining members.

Several places this flow leaks:

- **Per-doc decrypt failure during step 3.** If a doc's title decrypt throws (lines 993-1004), the rotation **continues** with a placeholder title. The subsequent `downloadDocumentState` for that doc uses the same old key; if it also fails (lines 1019-1022) the doc is moved to `progress.documentsFailed` but the rotation does not abort. After rotation, that doc's index entry + snapshot remain encrypted with key v(N-1). Members who only have key v(N) cannot decrypt it. **This matches the symptom exactly: "some are there and some aren't".**
- **Late-joining members.** `autoWrapNewMembers(orgId)` (called from `onMemberAdded` and `onIdentityKeyUploaded` in `collabDocuments.ts:427-437`) wraps only the **current** org key for the new member. The new member never receives wrapped copies of any archived keys. If rotation didn't successfully re-encrypt every existing doc, the new member sees a permanent locked-doc state for those entries.
- **Rotation-lock race.** The barrier is set via HTTP after step 1. Between client-side `archiveCurrentOrgKey` (line 913) and the server acknowledging `rotation-lock` (lines 950-957), a concurrent member could still write using the previous current-key fingerprint. The server-side write-barrier should reject those, but during outages or if the barrier returns a non-2xx, step 1b throws and rotation aborts — but the local archive has already happened (line 913 ran before the throw at line 963), so the client thinks rotation occurred when it didn't.
- **Wire protocol carries no key fingerprint on reads.** `EncryptedDocIndexEntry` (`packages/collab-protocol/src/teamRoom.ts:192-200`) and `EncryptedDocUpdate`/`EncryptedDocSnapshot` (`packages/collab-protocol/src/teamDocument.ts:140-155`) carry only the IV and ciphertext, no per-payload key fingerprint. Even if the client wanted to try archived keys, it has no hint about which archived key to try — it would have to brute-force every archived generation. The fingerprint goes the OTHER direction (writes carry `orgKeyFingerprint` for the server to validate epoch on `DocUpdateMessage`/`DocCompactMessage`).

### Why "offline" rather than "decrypt failed"

The parent's per-payload tolerant decrypt fix (`DocumentSync.ts:646-660,666-682,738-745`) is what changed undecryptable payloads from "kill the room" to "skip this update; sync continues". The good side-effect: status no longer flips to `'error'`. The bad side-effect: when ALL of a doc's snapshot+updates are undecryptable for this client, the Y.Doc stays empty, the doc shows as 'connected' but blank. From the user's POV that's indistinguishable from "offline" — especially when Symptom 1's binding race adds further blank-canvas opportunities.

For doc-index entries, the parent's other fix returns a `decryptFailed: true` placeholder, so the user will at least see the row. Without that, the doc disappears entirely — the legacy `decryptDocuments` would drop it.

### Minimal fix sketch

The cleanest fix has two parts:

**(a) Add key fingerprint to the wire on reads.** Update `EncryptedDocIndexEntry`, `EncryptedDocUpdate`, `EncryptedDocSnapshot` to carry a `keyFingerprint: string` field. Server records the fingerprint on write (it already receives it via `DocUpdateMessage.orgKeyFingerprint`) and echoes it on read. Client uses it to look up the correct archived key via `getArchivedOrgKeyByFingerprint`.

**(b) Wire the fallback into both decrypt sites.**

- `DocumentSync` and `TeamSync` need a `getKeyForFingerprint(fingerprint: string): Promise<CryptoKey | null>` callback in their config, that the main process implements by trying `getOrgKey` first then archived keys.
- `decryptBinary`/`decryptTitle` consult the callback when the wire payload carries a fingerprint; default to the current `encryptionKey` only when the wire payload is from a pre-fingerprint era (until migration completes).
- When fingerprint is present and key resolution fails (e.g., user never had that historical key), return a structured error so the UI can show "admin needs to share the v(N-1) key with you" rather than silent failure.

**(c) Make `performKeyRotation` fail-stop on partial decryption.** Today's "include with placeholder" branch (KeyRotationService.ts:993-1004) is what produces the "some docs missing" state. Either abort the rotation when ANY doc/tracker/asset fails to decrypt with the old key, or skip the entries entirely and emit a re-rotation request when their owners next come online. Continuing with partial re-encryption is worse than not rotating.

If a full wire-protocol change is too heavy: a minimal client-side fallback that just tries the current key, then each archived key in newest-to-oldest order, recovers most of the practical cases. It's slower per-failure but the failure rate is bounded by the number of rotations (typically very small per org).

---

## Other things noticed (worth a follow-up tracker item, not part of these two symptoms)

### A. `requeueInflightPendingUpdate` race in `replayPendingUpdate`

`DocumentSync.replayPendingUpdate` (lines 880-941) sets `inflightPendingUpdate` before the `await encryptBinary` but sets `replayingClientUpdateId` after it. A second concurrent invocation slipping into the gap will:
1. See `replayingClientUpdateId === null` (the guard passes).
2. Consume the (rebuilt) `queuedPendingUpdate`.
3. Overwrite `inflightPendingUpdate` with its own bytes.

The first invocation's WS `send` still happens — but its inflight bookkeeping is now stale (`inflightPendingUpdate` no longer refers to the bytes that are actually in flight). On disconnect mid-send, `requeueInflightPendingUpdate` requeues the SECOND-invocation bytes, not what was actually unacked. CRDT-merging usually papers over this, but it's a real correctness gap and would matter for any future "exactly-once delivery" telemetry.

Suggested fix: set `replayingClientUpdateId` synchronously **before** the `await encryptBinary`, then clear/replace it inside the catch on failure.

### B. `flushPendingPersistImmediately` is fire-and-forget in `destroy()`

`DocumentSync.destroy` (lines 331-341) calls `flushPendingPersistImmediately` which does `void this.config.onPendingUpdateChange(...)` — the IPC is queued but not awaited, and `destroy` then nulls out internal state. Today this is fine because the renderer outlives the IPC dispatch, but any future change that makes the renderer unmount tear down synchronously (or that adds critical state-mutating logic in the same teardown path) could lose pending updates silently.

### C. SDK hook's `[host]` dep + ref-based readiness signals

The `useCollaborativeEditor` hook (`packages/extension-sdk/src/useCollaborativeEditor.ts:179-241`) only re-runs when `host` changes. Extensions that need to coordinate "binding-ready" with their own imperative-API mount (Excalidraw, Monaco, RevoGrid, anything with `forwardRef`) currently have to plumb that themselves via refs that don't trigger React re-renders. Today's no-op fallback masks the race; tomorrow's blank canvases. Suggest adding an explicit "ready" coordination affordance to the hook — or at minimum, an SDK-level `onCollaborationStatusChange` event after binding so extensions can detect and recover from `binding === null`.

### D. `pushLocalState` is dead-code-adjacent on the share path

`pushLocalState` (lines 862-878) was added to handle "content bootstrapped locally before WS connect" but for `useCollaborativeEditor`-style extensions, the seed always lands after status='connected' (because tryStart waits for the connected event). So `pushLocalState` always reads an empty Y.Doc and returns early. The seed actually arrives via the local-update observer. Not broken, but the comment at lines 853-861 implies it's load-bearing when it isn't; future readers may add features depending on its semantics that don't actually hold.

### E. Reopen path doesn't carry `initialContent`

`resolveCollabConfigForUri` (`packages/electron/src/renderer/utils/collabDocumentOpener.ts:307-374`) intentionally omits `initialContent` — correct, because the server is the source of truth on reopen. But it interacts with Symptom 1: if the seed didn't reach the server (or was lost), there's no fallback to local file content. A future "local-origin binding" feature could re-seed from the linked local file when sync brings nothing; today the user gets a blank tab.

---

## Verification status

This is a read-only analysis. None of the fixes above have been implemented or tested. The hypothesis for Symptom 1 (Excalidraw API race) would be confirmed by either:
- Adding a `console.log('[ExcalidrawEditor] createBinding called, api=', !!excalidrawAPIRef.current)` and reproducing the reopen flow with throttled CPU, or
- Writing a focused unit test that drives `useCollaborativeEditor` against a fake collab context whose status flips to 'connected' before the createBinding callback can read the ref (the test would need to model the createBinding-returns-noop path).

The hypothesis for Symptom 2 (post-rotation undecryptable subset) is more architectural and would be confirmed by `wrangler tail`ing the prod sync worker while the affected user opens their workspace, observing per-doc `docSyncResponse` payloads with key generations the client can't decrypt. The investigator can also inspect the local `~/Library/Application Support/@nimbalyst/electron/orgKeys/<orgId>.json` for archived keys vs. the current key's fingerprint, and cross-reference with the server-side `currentOrgKeyFingerprint` from `TeamState.metadata` (which is broadcast on `teamSync`).
