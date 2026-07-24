---
planStatus:
  planId: plan-realtime-document-collaboration
  title: "Realtime Document Collaboration with E2E Encryption"
  status: implemented
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders:
    - development-team
  tags:
    - collaboration
    - encryption
    - yjs
    - durable-objects
    - zero-trust
  created: "2026-02-21"
  updated: "2026-02-26T00:00:00.000Z"
  progress: 90
---
# Realtime Document Collaboration with E2E Encryption

A zero-trust architecture for realtime collaborative editing of markdown documents using Yjs CRDTs, Cloudflare Durable Objects, and end-to-end encryption. The server acts as a dumb encrypted relay -- it cannot read document content, edit operations, or awareness state.

## Context

### Why Yjs for Documents (vs. Append-Only for Sessions)

The existing collabv3 sync system deliberately chose append-only message logs over CRDTs for AI session sync. That's correct for sessions -- messages are linear and don't have concurrent edits.

Documents are different:
- Concurrent edits at different positions
- Cursor positions and selections that must survive remote edits
- Conflict-free merging when multiple users type simultaneously
- Offline edits that need to merge on reconnect

Yjs handles all of these natively via its CRDT model. The challenge is combining Yjs with E2E encryption in a zero-trust architecture where the server never sees plaintext.

### Existing Infrastructure

| Component | Status | Relevance |
|-----------|--------|-----------|
| CollabV3 Durable Objects | Production | Same DO pattern, new room type |
| AES-256-GCM encryption | Production | Same cipher, new key management |
| Stytch B2B JWT auth | Production | Same auth, org-scoped rooms |
| WebSocket hibernation | Production | Same pattern for cost efficiency |
| Yjs library | Available (npm) | Client-side only, not currently used |

## Threat Model

### What E2E Encryption Solves

The server (Cloudflare, our infrastructure) cannot read:
- Document content
- Individual edit operations
- What changed in any given update
- Cursor positions or selections

### What E2E Encryption Does NOT Solve

**Collaborator trust is a separate problem.** Once you share a document key with user B, they have an indirect write path to your filesystem via the autosave pipeline:

```
User B types something
  -> Yjs update encrypted with shared document key
  -> DO relays encrypted blob
  -> Your client decrypts, merges into Y.Doc
  -> Autosave writes to disk
```

#### Collaborator Threat Vectors

1. **Content injection**: Markdown containing malicious frontmatter, script blocks, or content that's dangerous when rendered/processed by automations
2. **Size exhaustion**: Flooding the document to fill disk via autosave
3. **Subtle content tampering**: Small, hard-to-notice changes to trusted documents (config values, spec numbers, instructions)

#### Mitigation: Treat Remote Edits Like AI Edits

The existing "pending review" system for AI-generated changes is the right model for remote collaborator edits:

- Remote changes merge into the Y.Doc immediately (collaborator sees their edits in real-time)
- Your client shows remote changes with gutter decorations (similar to AI pending review indicators)
- Remote changes do NOT autosave to disk until you accept them (explicitly or via bulk accept/save)
- Your own local changes still autosave normally
- If your client crashes before accepting, remote changes re-sync from the DO on reconnect (nothing is permanently lost)

This reuses existing infrastructure and is honest about the trust boundary: E2E encryption protects from the server/network, the review gate protects from collaborators.

### Server Visibility Audit

| Data | Server can see? |
|------|----------------|
| Document content | No (encrypted blob) |
| Edit operations | No (encrypted blob, can't tell what changed) |
| Document structure | No |
| Who is editing | Yes (user IDs from JWT auth) |
| When edits happen | Yes (timestamps) |
| Document size | Approximate (from blob sizes) |
| Cursor positions | No (encrypted awareness) |

## Architecture

### Overview

```
Client A                    DocumentRoom DO              Client B
   |                             |                           |
   | 1. Connect (JWT auth)       |                           |
   |---------------------------->>|                           |
   |                             |                           |
   | 2. Request key envelope     |                           |
   |---------------------------->>|                           |
   |<<----------------------------|                           |
   |   (encrypted document key)  |                           |
   |                             |                           |
   | 3. syncRequest(sinceSeq=0)  |                           |
   |---------------------------->>|                           |
   |<<----------------------------|                           |
   |   (encrypted Yjs updates)   |                           |
   |                             |                           |
   | 4. Client decrypts each     |                           |
   |    update, applies to       |                           |
   |    local Y.Doc              |                           |
   |                             |                           |
   | 5. User types, Yjs emits    |                           |
   |    update -> encrypt ->     |                           |
   |    send encrypted blob      |                           |
   |---------------------------->>|                           |
   |                             | 6. Store + broadcast      |
   |                             |--------------------------->>|
   |                             |   (encrypted blob)        |
   |                             |                           |
   |                             |     7. Client B decrypts  |
   |                             |        + merges into Y.Doc|
```

### DocumentRoom Durable Object

A new DO type alongside SessionRoom and IndexRoom. The critical insight: **the DO never merges Yjs state.** It stores and relays encrypted blobs. All CRDT merging happens client-side.

```sql
-- Encrypted Yjs update blobs, opaque to server
CREATE TABLE encrypted_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_data BLOB NOT NULL,       -- encrypted Yjs update
  iv TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_updates_sequence ON encrypted_updates(sequence);

-- Per-user encrypted document keys (ECDH key exchange)
CREATE TABLE key_envelopes (
  target_user_id TEXT NOT NULL,
  wrapped_key BLOB NOT NULL,       -- document key encrypted with ECDH shared secret
  iv TEXT NOT NULL,
  sender_public_key TEXT NOT NULL,  -- JWK, so receiver can derive shared secret
  created_at INTEGER NOT NULL,
  PRIMARY KEY (target_user_id)
);

-- Compacted snapshots replace historical updates
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  encrypted_state BLOB NOT NULL,   -- encrypted full Y.Doc state
  iv TEXT NOT NULL,
  replaces_up_to INTEGER NOT NULL, -- sequence number this snapshot covers
  created_at INTEGER NOT NULL
);

-- Document metadata (key-value, same pattern as SessionRoom)
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Room ID format: `org:{orgId}:doc:{documentId}`

### Sync Protocol

```typescript
// Client -> Server
type DocClientMessage =
  | { type: 'docSyncRequest'; sinceSeq: number }
  | { type: 'docUpdate'; encryptedUpdate: string; iv: string }
  | { type: 'docCompact'; encryptedState: string; iv: string; replacesUpTo: number }
  | { type: 'docAwareness'; encryptedState: string; iv: string }
  | { type: 'addKeyEnvelope'; targetUserId: string; wrappedKey: string; iv: string; senderPublicKey: object }
  | { type: 'requestKeyEnvelope' }

// Server -> Client
type DocServerMessage =
  | { type: 'docSyncResponse'; updates: EncryptedUpdate[]; snapshot?: EncryptedSnapshot; hasMore: boolean; cursor: number }
  | { type: 'docUpdateBroadcast'; encryptedUpdate: string; iv: string; fromConnectionId: string }
  | { type: 'docAwarenessBroadcast'; encryptedState: string; iv: string; fromUserId: string }
  | { type: 'keyEnvelope'; wrappedKey: string; iv: string; senderPublicKey: object }
  | { type: 'error'; code: string; message: string }
```

## Key Exchange: ECDH + Key Wrapping

### Identity Key Pairs

Each user generates an ECDH key pair once, stored in secure client storage (Electron `safeStorage` / iOS Keychain):

```typescript
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' },
  false,  // private key not extractable
  ['deriveKey', 'deriveBits']
);

// Public key uploaded to server (safe -- it's public)
const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
```

### Document Key Creation

When creating a document for collaboration, generate a random symmetric key:

```typescript
const documentKey = await crypto.subtle.generateKey(
  { name: 'AES-GCM', length: 256 },
  true,   // extractable -- we need to wrap it for sharing
  ['encrypt', 'decrypt']
);
```

### Invitation Flow

When user A invites user B to collaborate:

1. A fetches B's public key from server
2. A derives a shared secret via ECDH: `sharedSecret = ECDH(A.privateKey, B.publicKey)`
3. A uses that shared secret as a wrapping key to encrypt the document key
4. A uploads the wrapped key envelope to the DocumentRoom DO
5. B connects, fetches their envelope
6. B derives the same shared secret via ECDH: `sharedSecret = ECDH(B.privateKey, A.publicKey)`
7. B unwraps the document key

```typescript
// User A wrapping the document key for User B
const bPublicKey = await importPublicKey(bPublicKeyJwk);

const wrappingKey = await crypto.subtle.deriveKey(
  { name: 'ECDH', public: bPublicKey },
  aPrivateKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['wrapKey']
);

const iv = crypto.getRandomValues(new Uint8Array(12));
const wrappedKey = await crypto.subtle.wrapKey(
  'raw', documentKey, wrappingKey,
  { name: 'AES-GCM', iv }
);

// Upload to DO
ws.send({
  type: 'addKeyEnvelope',
  targetUserId: bUserId,
  wrappedKey: base64(wrappedKey),
  iv: base64(iv),
  senderPublicKey: aPublicKeyJwk
});
```

```typescript
// User B unwrapping the document key
const aPublicKey = await importPublicKey(envelope.senderPublicKey);

const wrappingKey = await crypto.subtle.deriveKey(
  { name: 'ECDH', public: aPublicKey },
  bPrivateKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['unwrapKey']
);

const documentKey = await crypto.subtle.unwrapKey(
  'raw',
  fromBase64(envelope.wrappedKey),
  wrappingKey,
  { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
  { name: 'AES-GCM', length: 256 },
  true,
  ['encrypt', 'decrypt']
);
```

### Key Exchange Server Visibility

| Data | Visible to server? |
|------|-------------------|
| Who is invited to a document | Yes (target_user_id) |
| The document key itself | No (wrapped with ECDH shared secret) |
| Users' public keys | Yes (harmless by design) |
| Users' private keys | Never leaves the client |
| The ECDH shared secret | No (derived independently by each client) |

### Key Rotation and Revocation

When removing a collaborator:

1. Owner generates a new document key
2. Re-encrypts the full Y.Doc snapshot with the new key
3. Sends new wrapped key envelopes to all remaining collaborators
4. Deletes the revoked user's envelope
5. All new updates use the new key

The revoked user still has the old key and could decrypt historical updates they previously had access to, but cannot decrypt anything new. True forward secrecy for CRDTs would require per-update ratcheting, which is impractical for realtime editing.

### Single-User Multi-Device Case

For one user across multiple devices, the flow simplifies. Each device has its own ECDH key pair and the "invitation" is the user wrapping the document key for their own second device. Alternatively, skip ECDH entirely for single-user and derive the document key from the UMK (same as current per-project key derivation), only switching to ECDH when multi-user sharing is needed.

## iOS Mobile Editing

The DocumentRoom architecture is device-agnostic -- encrypted Yjs updates over WebSocket. The iOS app already has the crypto primitives (AES-256-GCM, PBKDF2 via node-forge) and WebSocket infrastructure from session sync, plus the encryption key seed from QR pairing. This means we can support collaborative editing on iOS with minimal new native code.

### Approach: Embedded WebView with Lexical + Yjs

Same pattern as the existing transcript viewer WebView. Bundle a lightweight web app containing Lexical + runtime editor plugins + Yjs + the encrypt/decrypt layer. Load it in a WKWebView. The native iOS shell provides auth and key material; the WebView handles editing and CRDT merging.

```
┌─────────────────────────────────────────────┐
│              iOS Native Shell                │
│  SwiftUI navigation, file browser, auth     │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         WKWebView (Editor)             │  │
│  │  Lexical + Runtime Editor + Yjs        │  │
│  │  - Full rich text editing              │  │
│  │  - Y.Doc per document                  │  │
│  │  - Encrypt/decrypt Yjs updates         │  │
│  │  - WebSocket to DocumentRoom           │  │
│  │  - Awareness (cursors from desktop)    │  │
│  └──────────────────┬─────────────────────┘  │
│                     │ JS Bridge               │
│  Native provides:   │                         │
│  - Document key (derived from UMK)            │
│  - Auth JWT for WebSocket                     │
│  - DocumentRoom URL + document ID             │
│  - User info (name, color for awareness)      │
└─────────────────────────────────────────────┘
```

**Why WebView, not native Yjs:**
- Identical editing experience to desktop (same Lexical, same custom nodes, same plugins)
- Zero native CRDT implementation -- Yjs runs in the WebView's JavaScript context
- The transcript WebView pattern is already proven in the iOS app
- Changes from iOS appear on desktop in realtime (both connect to the same DocumentRoom)

**Key management for single-user cross-device:**
- No ECDH needed -- derive the document key from the existing UMK (user master key seed) that's already shared via QR pairing
- The iOS app already has `encryptionKeySeed` from pairing
- Same PBKDF2 derivation as desktop: `deriveKey(seed, salt: "nimbalyst:{userId}")`
- Same key, same DocumentRoom, two devices editing the same Y.Doc

**Autosave behavior on iOS:**
- iOS has no local filesystem to autosave to -- the Y.Doc state lives in-memory in the WebView
- Edits go directly to the DocumentRoom via WebSocket
- Desktop receives the updates, merges into its Y.Doc, and autosaves to disk (with review gate if multi-user)
- For single-user: desktop autosaves iOS edits immediately (no review gate -- it's you on both devices)
- If the iOS app is backgrounded/killed, state recovers from the DocumentRoom on next launch

**What iOS does NOT need:**
- Review gate (that's a desktop concern -- iOS doesn't write to the filesystem)
- Local persistence of Y.Doc state (recover from server on reconnect)
- Compaction (desktop handles that -- any client can compact, only one needs to)

## Awareness: Typing and Selection

Awareness is scoped to typing indicators and cursor/selection positions only -- not mouse tracking. At 1-2Hz update rate with small payloads (~100 bytes plaintext, ~150 encrypted), AES-GCM overhead is negligible.

```typescript
// What travels over the wire (server sees this)
interface EncryptedAwareness {
  userId: string;              // plaintext, needed for routing
  encryptedState: string;      // base64 AES-GCM ciphertext
  iv: string;
}

// What's inside after decryption (server never sees this)
interface AwarenessState {
  cursor?: { index: number; length: number };  // Yjs relative position
  user: { name: string; color: string };
}
```

Use **Yjs relative positions** (`Y.createRelativePositionFromTypeIndex`) for cursor positions, not absolute character offsets. Relative positions survive concurrent edits -- if someone inserts text before your cursor, your relative position still resolves correctly after the remote update is merged.

Awareness is purely ephemeral -- held in the DO's in-memory connection map, never stored to SQLite. Broadcast to all other connections, same pattern as the existing `messageBroadcast`.

## State Compaction

Yjs state grows over time as updates accumulate. Periodically, a client needs to snapshot the full Y.Doc state and replace the update history:

```typescript
// Client-side compaction
const fullState = Y.encodeStateAsUpdate(doc);
const iv = crypto.getRandomValues(new Uint8Array(12));
const encrypted = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv },
  documentKey,
  fullState
);

ws.send({
  type: 'docCompact',
  encryptedState: base64(encrypted),
  iv: base64(iv),
  replacesUpTo: currentMaxSequence
});
```

The DO stores the snapshot and can delete updates with `sequence <= replacesUpTo`, but keeps a small overlap window (retain N updates after compaction) so late-arriving clients with unsynced edits can still merge. Since the DO can't read the data, it can't do compaction itself -- it must be driven by a client.

### Compaction Conflict Handling

If client A compacts while client B has unsynced edits, B's updates reference state vectors that no longer exist on the server. The overlap window handles this for small delays. For longer offline periods, B would need to:
1. Fetch the latest snapshot
2. Decrypt and apply it to a fresh Y.Doc
3. Merge their local pending updates on top
4. Re-encrypt and send any resulting new updates

## Offline Support

Clients accumulate encrypted Yjs updates locally while offline. On reconnect:

1. Send a `docSyncRequest` with `sinceSeq` = last known sequence
2. Receive any remote updates that happened while offline
3. Decrypt and merge remote updates into local Y.Doc
4. Send local buffered updates to the server

Since Yjs handles merge conflicts natively, this works as long as both sides have the same document key. The only constraint is compaction -- if the server compacted while you were offline and your local state is too old, you may need to re-sync from the snapshot.

## Desktop Editor Integration

Collaborative documents are fundamentally different from local files. They don't live on disk -- they live in a DocumentRoom. This section covers how collaborative documents integrate with the Nimbalyst desktop editor.

### Two Editor Modes

The Lexical editor has two operating modes:

**Mode 1: Local File (existing)**
```
Disk -> host.loadContent() -> markdown string -> $convertFromEnhancedMarkdownString() -> Lexical
User edits -> Lexical -> $convertToEnhancedMarkdownString() -> host.saveContent() -> Disk
```

**Mode 2: Collaborative Document (new)**
```
DocumentRoom -> DocumentSyncProvider -> Y.Doc (source of truth)
Y.Doc <-> @lexical/yjs createBinding() <-> Lexical EditorState (bidirectional, automatic)
Remote edits -> Y.Doc -> Lexical re-renders (live)
Local edits -> Lexical -> Y.Doc -> encrypt -> server -> other clients
Serialize: Y.Doc -> serialize to markdown string (for diff display and agent tools)
```

In Mode 1, Lexical owns the content and markdown is the serialization format. In Mode 2, the Y.Doc owns the content, Lexical is a view of it, and markdown is a derived representation used for diffs and agent tooling.

`@lexical/yjs` (already a dependency of `@nimbalyst/runtime`) provides `createBinding()` which two-way syncs between a `LexicalEditor` instance and a `Y.Doc`. The existing `collaboration.ts` in `packages/runtime/src/editor/` shows the shape of this integration (playground code, not production). The key difference from the stock Lexical collaboration setup: we use our own `DocumentSyncProvider` with AES-256-GCM encryption instead of the stock `y-websocket` provider.

### Tab Identity: `collab://` URI Scheme

The current tab/editor system is built around file paths as identity. Everything -- EditorKey, dirty state atoms, file watcher subscriptions, save handlers, autosave timers -- keys off a file path.

Collaborative documents use a new URI scheme instead:

```
collab://org:{orgId}:doc:{documentId}
```

This follows the existing `virtual://` protocol precedent (used for welcome page, tracker views). The tab system already handles non-filesystem paths:
- `TabsContext.tsx` skips file watcher for `virtual://` paths
- `TabContent.tsx` routes `virtual://` paths to different content loaders
- `TabMetadata` has extensible metadata fields

The `collab://` scheme extends this pattern:
- `EditorKey` format: `main:collab://org:abc:doc:xyz` or `session:{id}:collab://org:abc:doc:xyz`
- File watcher: skipped (no disk file to watch)
- Content loader: connects DocumentSyncProvider instead of reading from disk
- Save handler: replaced by review gate accept/reject flow
- Tab display: shows collaboration indicators (user avatars, access controls) instead of file path

### Agent Access via MCP Tools

The AI agent (Claude Code via agent-sdk) currently interacts with files through the filesystem -- it reads and writes files directly, and the file watcher picks up changes. Collaborative documents have no local file, so the agent needs MCP tools:

**Tools (registered in Nimbalyst's internal MCP server):**

| Tool | Purpose | Review Gate |
|------|---------|-------------|
| `read_collab_doc` | Read current document content as markdown | No (read-only) |
| `edit_collab_doc` | Apply edits to the document | Yes -- triggers review gate |
| `list_collab_docs` | List documents the user has access to | No |

**Agent edit flow:**
```
Agent calls edit_collab_doc
  -> MCP tool captures Y.Doc state vector (pre-edit baseline)
  -> Tool applies edit to Y.Doc (agent is treated as a remote author)
  -> Review gate buffers the change
  -> onReviewStateChange fires -> UI shows pending review
  -> User sees red/green diff of agent's changes
  -> User accepts or rejects
```

The agent's edits flow through the **same review gate** as remote collaborator edits. The review gate doesn't distinguish between changes from a WebSocket peer vs a local MCP tool call -- both are non-local changes that need user approval. The agent's userId is used as the `senderId` for the buffered update, so the review UI can show "Changes from Claude" vs "Changes from Alice".

**Content format for agent tools:**

The `read_collab_doc` tool serializes the Y.Doc to markdown using the same `$convertToEnhancedMarkdownString()` pipeline as local file save. The `edit_collab_doc` tool accepts markdown edits (insertions, replacements, deletions by line range) and applies them to the Y.Doc by:
1. Serializing current Y.Doc content to markdown
2. Applying the text edit to the markdown string
3. Parsing the edited markdown back to Lexical nodes
4. Diffing and applying the changes to the Y.Doc

This is intentionally the same edit model the agent uses for local files -- the agent doesn't need to know whether it's editing a local file or a collaborative document.

### Diff Review for Agent and Remote Edits

The existing AI pending review system uses `HistoryManager` to capture pre-edit file snapshots, then shows red/green diffs via Lexical's `APPLY_MARKDOWN_REPLACE_COMMAND`. For collaborative documents, the Y.Doc state vector replaces the history snapshot:

**Current (local files):**
```
HistoryManager creates pre-edit tag -> agent writes file -> file watcher detects
  -> diff: tag content vs new file content -> user accepts/rejects
```

**Collaborative documents:**
```
Review gate captures pre-edit SV -> change applied to Y.Doc
  -> diff: Y.encodeStateAsUpdate(doc, reviewedSV) -> serialize both states to markdown
  -> same red/green diff display -> user accepts/rejects via review gate
```

The diff computation:
1. `getReviewedStateVector()` returns the SV at the last acceptance point
2. Create a temporary Y.Doc, apply state up to the reviewed SV -> serialize to markdown (the "before")
3. Serialize the current Y.Doc to markdown (the "after")
4. Show the standard red/green diff between the two markdown strings
5. On accept: `acceptRemoteChanges()` advances the SV
6. On reject: `rejectRemoteChanges()` clears the buffer; Y.Doc content reverts on next sync if the user's compaction overwrites

This reuses the exact same diff rendering infrastructure. The only difference is the source of the "before" and "after" content.

### Visual Differentiation

Collaborative document tabs must be visually distinct from local file tabs:

- **Tab icon**: Collaboration icon instead of file type icon
- **Tab label**: Document title (from DocumentRoom metadata) instead of filename
- **Header bar**: Shows connected collaborators (avatars from awareness), document sharing/access settings, connection status indicator
- **Editor chrome**: Remote cursor decorations (via `@lexical/yjs` awareness + CSS), user name labels on cursors
- **Review banner**: "N changes pending review from [Alice, Claude]" with Accept All / review individually

### EditorHost Adaptation

Rather than modifying EditorHost (which is the contract for all editors including extensions), collaborative documents use a different integration path:

- **`CollaborativeEditorHost`**: A new host implementation that wraps `DocumentSyncProvider` and provides the same interface shape but with different backing:
  - `loadContent()` -> serializes Y.Doc to markdown (for initial render before `@lexical/yjs` binding takes over)
  - `saveContent()` -> no-op or error (saves go through review gate, not EditorHost)
  - `onFileChanged()` -> wired to `onRemoteUpdate` from DocumentSyncProvider
  - `setDirty()` -> tracks local changes (Y.Doc always has latest, but dirty indicates user has made changes since last accept)
  - `onSaveRequested()` -> triggers accept flow instead of disk save

- **`MarkdownEditor`** receives a new optional prop: `collaborationProvider?: DocumentSyncProvider`
  - When present, skips `initialContent` / `$convertFromEnhancedMarkdownString()` path
  - Instead, uses `@lexical/yjs` `createBinding()` to bind Lexical to the Y.Doc
  - Remote cursor rendering via awareness subscription
  - All other editor behavior (toolbar, plugins, custom nodes, keyboard shortcuts) is identical

## Comparison to Existing CollabV3

| Aspect | Current (AI sessions) | Document collaboration (Desktop) | Document collaboration (iOS) |
|--------|----------------------|----------------------------------|------------------------------|
| Data model | Append-only messages | CRDT (concurrent edits) | CRDT (same Yjs in WebView) |
| Merging | None needed (linear) | Client-side Yjs merge | Client-side Yjs merge (WebView) |
| Server role | Store + relay | Dumb relay + blob store | Same DocumentRoom |
| Key model | Per-project UMK-derived | Per-document ECDH (multi-user) or UMK-derived (single-user) | UMK-derived (single-user) |
| Compaction | Not needed | Required (state growth) | Not responsible (desktop compacts) |
| Awareness | N/A | Encrypted cursor/selection at 1-2Hz | Same (WebView) |
| Autosave | Direct write | Review gate for remote changes | N/A (no local filesystem) |
| Persistence | PGLite | PGLite + filesystem | Server-only (recover on launch) |

## Implementation Phases

### Phase 1: DocumentRoom Durable Object -- DONE

Completed files:
- `packages/collabv3/src/DocumentRoom.ts` -- DO with SQLite schema, 6 message handlers, hibernation, TTL alarm
- `packages/collabv3/src/types.ts` -- DocumentRoomId, DocClientMessage, DocServerMessage, EncryptedDocUpdate, EncryptedDocSnapshot
- `packages/collabv3/src/index.ts` -- Routing (`org:{orgId}:doc:{documentId}`), org-scoped auth (no userId in room ID)
- `packages/collabv3/wrangler.toml` -- DOCUMENT_ROOM binding + v2 migration

E2E integration test infrastructure:
- `packages/collabv3/src/index.ts` -- TEST_AUTH_BYPASS env var (dev-only, bypasses JWT for integration tests)
- `packages/collabv3/test/helpers.ts` -- startWrangler/stopWrangler, WebSocket test utilities
- `packages/collabv3/test/documentRoom.integration.test.ts` -- 8 tests against local wrangler dev server (sync, broadcast, persistence, delta sync, compaction, awareness, key envelopes)

### Phase 2: Client-Side Yjs + Encryption Layer -- DONE

Completed files:
- `packages/runtime/src/sync/documentSyncTypes.ts` -- DocumentSyncConfig, DocumentSyncStatus, AwarenessState, wire protocol types
- `packages/runtime/src/sync/DocumentSync.ts` -- DocumentSyncProvider class (Y.Doc lifecycle, AES-256-GCM encrypt/decrypt, WebSocket sync, awareness)
- `packages/runtime/src/sync/index.ts` -- Exports DocumentSyncProvider and types

Integration tests (`packages/collabv3/test/documentSync.integration.test.ts`, 6 tests):
1. Connect, sync, and reach connected status
2. Sync Yjs text between two providers (user1 types, user2 receives)
3. Bidirectional edits (both users type, both Y.Docs converge)
4. Recover state on reconnect via sync (persisted encrypted updates)
5. Verify encryption (sent messages contain only encrypted blobs, no plaintext)
6. Awareness broadcast between providers

Test infrastructure:
- `packages/collabv3/test/globalSetup.ts` -- Starts/stops a single wrangler dev instance shared across all test files
- `packages/collabv3/vitest.config.ts` -- Uses globalSetup, sequential file execution

### Phase 3: ECDH Key Exchange -- DONE

Completed files:
- `packages/runtime/src/sync/ECDHKeyManager.ts` -- ECDHKeyManager class: ECDH P-256 key pair generation, serialization/deserialization, document key wrapping (AES-GCM wrapKey) and unwrapping (unwrapKey), public key export as JWK
- `packages/runtime/src/sync/index.ts` -- Exports ECDHKeyManager and types
- `packages/collabv3/src/index.ts` -- REST API endpoints: `PUT /api/identity-key` (upload public key with P-256 validation, private key rejection), `GET /api/identity-key/{userId}` (fetch public key, org-scoped isolation); also added TEST_AUTH_BYPASS to REST API routes
- `packages/collabv3/migrations/0003_create_identity_public_keys.sql` -- D1 table for org-scoped identity public keys
- `packages/collabv3/test/globalSetup.ts` -- Updated to apply D1 migrations before starting wrangler dev
- `packages/collabv3/test/helpers.ts` -- Added `fetchWithTestAuth()` for authenticated HTTP requests

Integration tests (`packages/collabv3/test/ecdhKeyExchange.integration.test.ts`, 8 tests):
1. Upload and fetch a public key via REST API
2. Return 404 for unknown user
3. Reject non-P256 keys
4. Reject keys with private component (d field)
5. Update existing public key on re-upload (upsert)
6. Enforce org isolation for key fetch
7. Wrap and unwrap a document key between two users (pure crypto)
8. End-to-end: public key upload, fetch, document key wrap, store envelope in DocumentRoom via WebSocket, retrieve envelope, unwrap, verify both keys encrypt/decrypt the same data

Note: Key envelope storage/retrieval in DocumentRoom was already implemented in Phase 1. Key rotation on collaborator removal is deferred to when the invitation UX is built (Open Question #6).

### Phase 4: Awareness (sync layer) -- DONE

Completed files:
- `packages/runtime/src/sync/documentSyncTypes.ts` -- Updated `AwarenessState.cursor` to use `SerializedRelativePosition` (base64-encoded Yjs relative positions) with `{anchor, head}` fields instead of raw numeric indices. Added `SerializedRelativePosition` type alias.
- `packages/runtime/src/sync/DocumentSync.ts` -- Added throttled awareness: `setLocalAwareness()` coalesces rapid cursor updates at ~2Hz (500ms throttle). Added stale awareness cleanup (removes entries after 30s of no updates). Fixed throttle timing to set `lastAwarenessSendTime` synchronously before async encryption.
- `packages/runtime/src/sync/index.ts` -- Added `SerializedRelativePosition` export
- `packages/collabv3/test/documentSync.integration.test.ts` -- Updated awareness test for new cursor format; added throttle test verifying coalescing behavior

Note: UI-layer work (Lexical cursor decorations, Yjs relative position conversion, remote cursor rendering) is deferred to the Electron integration phase. The sync layer provides the full pipeline: throttled send -> encrypt -> relay via DocumentRoom -> decrypt -> state tracking with stale cleanup.

### Phase 5: Autosave Review Gate (sync layer) -- DONE

Completed files:
- `packages/runtime/src/sync/documentSyncTypes.ts` -- Added `ReviewGateState` interface (hasUnreviewed, unreviewedCount, unreviewedAuthors). Added `reviewGateEnabled` and `onReviewStateChange` to `DocumentSyncConfig`.
- `packages/runtime/src/sync/DocumentSync.ts` -- Added review gate to DocumentSyncProvider:
  - `reviewGateEnabled` property: opt-in flag (default false, use true for multi-user collab)
  - `hasUnreviewedRemoteChanges()`: boolean check for autosave gate
  - `getReviewGateState()`: full state with count and author list
  - `getUnreviewedUpdates()`: raw Yjs update bytes for UI diff rendering
  - `getReviewedStateVector()`: SV at last acceptance point
  - `getUnreviewedDiff()`: computed Yjs update representing all unreviewed remote changes
  - `acceptRemoteChanges()`: advances reviewed SV, clears buffer, notifies callback
  - `rejectRemoteChanges()`: clears buffer without advancing SV (host restores from last save)
  - Initial sync data is accepted automatically (review gate only applies to realtime broadcasts)
  - Unreviewed state preserved across disconnect/reconnect
- `packages/runtime/src/sync/index.ts` -- Added `ReviewGateState` export

Integration tests (`packages/collabv3/test/documentSync.integration.test.ts`, 8 new tests):
1. No flags when reviewGateEnabled is false (default behavior preserved)
2. Track remote changes as unreviewed when gate enabled
3. Accept clears unreviewed state and notifies callback
4. Initial sync data not marked as unreviewed
5. Local edits don't trigger review gate
6. Accumulate updates from multiple remote users with author tracking
7. Compute unreviewed diff via getUnreviewedDiff()
8. Reject clears buffer without advancing state vector

Design decisions:
- Review gate is opt-in via `reviewGateEnabled` config flag. Default false preserves existing behavior for single-user multi-device sync (no review needed for your own edits).
- Remote updates are always applied to the Y.Doc immediately (CRDT correctness). The gate only controls whether the host should autosave.
- Rejection is soft: CRDTs can't truly undo merged operations. The host restores from its last saved file (which doesn't include remote changes, since the gate prevented autosave).
- UI-layer work (Electron HistoryManager integration, gutter decorations, PendingReviewBanner for collab) is deferred to the Electron integration phase.

### Phase 6: Desktop Editor Integration
This is the major integration phase. See "Desktop Editor Integration" section above for full architecture.

#### 6a: `collab://` Tab Infrastructure
- Add `collab://` URI scheme handling to TabsContext, TabContent, TabManager
- `CollaborativeEditorHost` implementation wrapping DocumentSyncProvider
- Tab display: collaboration icon, document title, connection status
- Skip file watcher, autosave timer, and save-to-disk for `collab://` tabs

#### 6b: Lexical-Yjs Binding
- `MarkdownEditor` `collaborationProvider` prop and mode switch
- `@lexical/yjs` `createBinding()` integration in Editor.tsx
- Skip `$convertFromEnhancedMarkdownString()` initial load path when Y.Doc is the source
- Verify all custom nodes (ImageNode, HashtagNode, ExcalidrawNode, etc.) work with Yjs binding

#### 6c: Agent MCP Tools
- `read_collab_doc` tool: serialize Y.Doc to markdown
- `edit_collab_doc` tool: apply markdown edits to Y.Doc via review gate
- `list_collab_docs` tool: enumerate accessible documents
- Register tools in Nimbalyst's internal MCP server (same pattern as session context tools)

#### 6d: Diff Review UI
- Compute before/after markdown from Y.Doc state vectors
- Wire review gate state to existing diff rendering infrastructure
- Review banner: "N changes pending review from [names]" with Accept All
- Reuse `APPLY_MARKDOWN_REPLACE_COMMAND` diff display for accept/reject

#### 6e: Awareness UI
- Remote cursor rendering via `@lexical/yjs` awareness + CSS overlays
- User name labels on cursors (from `AwarenessState.user`)
- Connected collaborators display in editor header bar

### Phase 7: iOS Mobile Editing
- Bundle Lexical + runtime editor + Yjs as a web app (similar to transcript viewer build)
- WKWebView integration in iOS app with JavaScript bridge for auth/key injection
- Document key derivation from existing `encryptionKeySeed` (same PBKDF2 as desktop)
- WebSocket connection to DocumentRoom from WebView
- Awareness support: iOS user's cursor visible on desktop, desktop cursors visible on iOS
- Native SwiftUI shell: document picker, file browser integration, navigation
- No review gate needed (iOS doesn't write to local filesystem)
- State recovery from DocumentRoom on app launch (no local Y.Doc persistence needed)

### Phase 8: Compaction and Offline
- Client-driven state compaction with encrypted snapshots
- Overlap window for late arrivals
- Local update buffering during offline periods
- Reconnection sync with snapshot + delta merge

## Tracker System Integration

DocumentRoom is the content layer for the [Collaborative Tracker System](./collaborative-tracker-system.md). Tracker items have two kinds of data that sync through different channels:

| Data | Sync channel | Reason |
|------|-------------|--------|
| Structured metadata (status, priority, assignee, labels) | TrackerRoom (encrypted blobs, field-level LWW) | Mutable fields, fast sync, client-side querying |
| Rich document content (descriptions, specs, plans) | DocumentRoom (encrypted Yjs updates, CRDT merge) | Concurrent text editing, cursor awareness, review gate |

**How it connects:**

A tracker item in the TrackerRoom includes an optional `documentId`. When present, that ID maps to a DocumentRoom where the item's rich content is collaboratively edited. Not all tracker items need a DocumentRoom -- simple bugs with just a title can store everything in the TrackerRoom's encrypted payload.

**Inline tracker items are local-only:**

Inline tracker references (`#bug[title status:open]`) are always local, personal annotations -- they never participate in TrackerRoom sync. If a shared document contains inline tracker syntax, those nodes sync as part of the Yjs document content (they're just nodes in the document), but they have no connection to the TrackerRoom. This avoids the complexity of a bidirectional sync bridge. If something needs collaborative tracking, promote it to a proper tracked item.

**Encryption alignment:**

Both TrackerRoom and DocumentRoom use **per-resource keys distributed via ECDH** -- the same pattern everywhere. Each document has its own AES-256 key; each tracker project has its own AES-256 key. Keys are wrapped per-participant via ECDH. When inviting someone to a project, all resource keys for that project (tracker key + any linked document keys) are wrapped for the new member in one batch. The UX feels like "add to project" but under the hood each resource maintains its own key for granular access control and revocation.

## Open Questions

1. **Compaction trigger**: When should a client compact? Options: after N updates, after X bytes, on a timer, or when the update log exceeds a threshold. Needs tuning based on real usage patterns.

2. ~~**Multi-document key management**~~: **Resolved.** Per-resource keys everywhere. Each document gets its own random AES-256 key, wrapped per-participant via ECDH. No org-level or project-level shared keys. The wrap operation is cheap (milliseconds per recipient). "Add to project" batches all resource key wraps into one UX action. This gives granular revocation (revoke access to one doc without re-keying everything) with minimal complexity. Same pattern as 1Password per-vault keys.

3. ~~**Yjs provider architecture**~~: **Resolved.** Custom `DocumentSyncProvider` in `packages/runtime/src/sync/DocumentSync.ts`. Does not use `y-websocket` -- we built our own encrypted WebSocket provider that encrypts each Y.Doc update with AES-256-GCM before sending.

4. **Editor integration depth**: `@lexical/yjs` provides `createBinding()` for two-way sync between a `LexicalEditor` and a `Y.Doc`. The stock binding handles standard Lexical nodes (text, element, decorator, linebreak). **Unknown**: how well it handles the runtime editor's custom nodes (ImageNode, HashtagNode, MarkNode, EmojiNode). Custom nodes with complex state (ImageNode with src/alt/dimensions) may need `excludedProperties` configuration or custom `CollabNode` implementations. Needs hands-on testing in Phase 6b. Note: ExcalidrawNode was removed during the rexical-to-runtime merge.

5. **Non-markdown editors**: Should DataModelLM, Excalidraw, and other custom editors also support realtime collaboration? Each would need its own Yjs binding. Excalidraw has native Yjs support; others would need custom work.

6. **Invitation UX**: How does a user invite a collaborator? Options: email invite, share link with embedded key, QR code pairing (like current device pairing), org-wide access.

7. ~~**Tracker inline node observer**~~: **Resolved.** Inline trackers are always local-only -- no sync bridge needed. This eliminates the bidirectional update problem entirely. See [Collaborative Tracker System, Section 1](./collaborative-tracker-system.md).

8. **Agent edit granularity**: The `edit_collab_doc` MCP tool applies edits by serializing to markdown, applying text changes, and parsing back. This round-trip may lose Yjs-level information (e.g., node identity, formatting that doesn't survive markdown round-trip). An alternative is operating directly on Y.Text with character-level insertions/deletions, but this requires the agent to work with offsets rather than markdown. The markdown round-trip approach is simpler and matches how agents edit local files, so it's the starting point.

9. **Document creation and lifecycle**: Where do collaborative documents come from? Options: (a) promote a local file to collaborative (copies content to a new DocumentRoom), (b) create new documents directly in the collaboration UI, (c) both. Related: how are documents listed/discovered? They're not in the file tree (no local file). Need a document browser or section in the sidebar.

10. **Markdown fidelity through Yjs**: The `@lexical/yjs` binding syncs Lexical's node tree, not markdown text. When the agent reads the document, it gets markdown serialized from the Lexical tree (via `$convertToEnhancedMarkdownString()`). When the agent writes, its markdown is parsed into Lexical nodes and diffed against the Y.Doc. The runtime editor's custom markdown import/export (2-space indentation, frontmatter extraction, enhanced transformers) must be used consistently. The standard Lexical `$convertFromMarkdownString()` must never be used.

## Security Review Findings

A code-level security audit was conducted on 2026-02-23 covering all implementation files. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) for the full report. Key items affecting this plan:

### P0 -- Must fix before multi-user collaboration ships

1. **Key envelope overwrite** (Finding 1, HIGH). Any org member can overwrite another user's key envelope via `INSERT OR REPLACE`. An attacker who joins a DocumentRoom before the victim can substitute their own envelope, causing the victim to unwrap the wrong key. Must restrict `addKeyEnvelope` to document owner or authorized key distributors.
2. **No sender verification on key envelopes** (Finding 2, HIGH). `unwrapDocumentKey` trusts whatever `senderPublicKey` is in the envelope without cross-referencing the sender's registered identity key from D1. Clients must verify the sender's public key against the identity key registry before unwrapping.
3. **TrackerSyncManager uses wrong key** (Finding 0, CRITICAL). Affects the tracker plan more than this one, but the same ECDH key distribution gap applies to DocumentSyncProvider's callers -- whoever instantiates a provider for a multi-user document must supply an ECDH-distributed key, not the personal QR seed.

### Enterprise readiness gaps

4. **SSO enforcement**: No org admin setting to require SSO and block magic-link/social login. Stytch B2B supports SAML/OIDC; Nimbalyst needs an org-level auth policy check. SSO enforcement also strengthens key distribution trust -- identity keys are bound to corporate-authenticated sessions.
5. **Admin recovery key**: Org admin must be able to recover document keys when employees leave. Every document key must be wrapped for an admin recovery key during creation.
6. **Key distribution audit trail**: No record of who was granted access to which documents. Required for SOC 2 / ISO 27001.
7. **Key rotation on member removal**: Described in this document's "Key Rotation and Revocation" section but not implemented. Required for access revocation to be meaningful.
8. **SCIM provisioning**: Automated member lifecycle (deprovision triggers ECDH key deregistration + re-keying of shared resources).

## Related Documents

- [Security Review](./SECURITY_REVIEW.md) - E2E encryption and trust model security audit
- [Collaborative Tracker System](./collaborative-tracker-system.md) - Realtime collaborative bug/task tracking
- [Session Share via Cloudflare](./session-share-cloudflare-hosting.md) - Phase 2 session sharing (complete)
- [Shared File Viewer](./shared-file-viewer.md) - Phase 3 file sharing with read-only viewers
- [CollabV3 CLAUDE.md](../../packages/collabv3/CLAUDE.md) - Sync server architecture reference
