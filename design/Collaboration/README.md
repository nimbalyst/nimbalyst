---
planStatus:
  planId: plan-nimbalyst-team
  title: "Nimbalyst Team: Collaborative AI Workspace"
  status: in-development
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders:
    - development-team
  tags:
    - collaboration
    - teams
    - encryption
    - sync
    - stytch-b2b
    - tracker
    - documents
  created: "2026-02-25"
  updated: "2026-02-26T00:00:00.000Z"
  progress: 75
---
# Nimbalyst Team

A set of features that lets teams work together with AI. The system is built on a zero-trust architecture where the server never sees plaintext content -- all collaboration is end-to-end encrypted, with the server acting as a dumb encrypted relay between clients.

## Architecture Overview

```
Desktop Client                    Cloudflare Workers                    Desktop Client
┌──────────────┐                 ┌──────────────────┐                 ┌──────────────┐
│ Lexical + Yjs│◄───WebSocket───►│  DocumentRoom DO │◄───WebSocket───►│ Lexical + Yjs│
│ TrackerSync  │◄───WebSocket───►│  TrackerRoom  DO │◄───WebSocket───►│ TrackerSync  │
│ TeamService  │◄─────REST──────►│  TeamRoom     DO │◄─────REST──────►│ TeamService  │
│ OrgKeyService│                 │  (per-org)       │                 │ OrgKeyService│
│ ECDHKeyMgr   │                 └──────────────────┘                 │ ECDHKeyMgr   │
└──────────────┘                         │                            └──────────────┘
       │                          Stytch B2B JWT                             │
       └─────── AES-256-GCM encryption ─┘─── AES-256-GCM encryption ────────┘
                (client-side only)                (client-side only)
```

Each org gets its own Durable Object with isolated SQLite storage. No cross-org queries are possible at the infrastructure level.

## Pillars

### 1. Stytch B2B Authentication

Migrated from Stytch B2C (consumer) to B2B (organizations). Every user belongs to at least one org (their personal org). Team orgs are created explicitly and members are invited by email with role-based access (owner, admin, member).

#### Personal Org vs Team Org

The Stytch B2B session is scoped to one org at a time. Session exchanges switch the JWT's org context. To prevent session sync from breaking when the user switches to a team org, the system maintains a **personal org ID** (`personalOrgId`) that is set once during initial authentication and never overwritten by session exchanges or refreshes.

- **Session sync** (SessionRoom, IndexRoom) always uses `personalOrgId` -- these hold the user's own data across all projects
- **Team collaboration** (DocumentRoom, TrackerRoom, TeamRoom) uses the current `orgId` from the JWT -- these are shared within a team org
- **Server authorization**: User-scoped rooms validate `userId` only (no org mismatch check). Org-scoped rooms validate both `userId` and `orgId`.

| Document | Status | Description |
| --- | --- | --- |
| [stytch-b2b-migration.md](./../../plans/stytch-b2b-migration.md) | Done | B2C-to-B2B auth migration for collabv3 server + desktop + iOS |
| [stytch-consumer-auth-system.md](./../MobileSync/stytch-consumer-auth-system.md) | Done | Original B2C auth system (historical reference) |

### 2. Team Trust Model

ECDH P-256 key exchange establishes trust between team members. Each user has an identity key pair stored in the OS keychain. Public keys are registered on the server. When a user joins a team, existing members wrap the org encryption key with the new member's public key (key envelope). Trust is verified by comparing key fingerprints out-of-band.

**Implementation status:** Server and desktop services are built. TeamRoom DO handles member management, key envelopes, identity keys, and doc index with full WebSocket push. Desktop has `TeamService.ts` (create/invite/remove/role-change via REST), `OrgKeyService.ts` (full ECDH lifecycle: generate, wrap, unwrap, upload, verify trust), and `TeamPanel.tsx` settings UI. Integration tests cover member CRUD, key exchange, role changes, envelope lifecycle, and doc index. Still needs: P0 security fixes (envelope auth, sender validation), auto-wrap for new members needs testing in multi-device scenarios.

| Document | Status | Description |
| --- | --- | --- |
| [team-management-trust-ui.md](./team-management-trust-ui.md) | Implemented | Team creation, member roles, ECDH trust, git remote linking |
| [KEY_ENVELOPE_DESIGN_ANALYSIS.md](./KEY_ENVELOPE_DESIGN_ANALYSIS.md) | Ready | Infrastructure audit and Phase B design for key distribution |
| [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) | Complete | Code-level audit of encryption architecture (8 findings, P0s still open) |
| [team-room-consolidation.md](./team-room-consolidation.md) | Done | Migrated team data from D1 into isolated per-org TeamRoom DO |

### 3. Realtime Collaborative Document Editing

Yjs CRDTs over E2E encrypted WebSocket channels. The DocumentRoom Durable Object stores opaque encrypted blobs -- it cannot read content, edit operations, or cursor positions. Desktop clients decrypt locally and merge via Yjs. Includes an autosave review gate so remote edits are held in-memory until accepted.

**Implementation status:** Full stack is built. Server: `DocumentRoom.ts` (695 lines) handles WebSocket sync, encrypted update storage, delta sync with `sinceSeq`, snapshot compaction, awareness relay, key envelope storage, and hibernation recovery. Client: `DocumentSync.ts` (755 lines) with connection management, Yjs update encryption/decryption, awareness throttling, review gate (track/accept/reject remote changes, unreviewed diff). `CollabLexicalProvider.ts` bridges Yjs to Lexical. `CollaborativeTabEditor.tsx` provides the editor wrapper. `CollabMode` components provide the document collaboration UI. `DocumentSyncHandlers.ts` wires IPC. Integration tests cover bidirectional sync, encryption verification, awareness broadcast, review gate (accept/reject/accumulate), reconnect recovery. Still needs: "Share to Team" flow UX polish, conflict indicators in the editor chrome.

| Document | Status | Description |
| --- | --- | --- |
| [realtime-document-collaboration.md](./realtime-document-collaboration.md) | Implemented | Zero-trust architecture: Yjs + Cloudflare DOs + E2E encryption |
| [implement-document-room.md](./prompts/implement-document-room.md) | Reference | Implementation prompt for DocumentRoom DO and desktop wiring |

### 4. Collaborative Tracker System

A Linear-like experience for tracking bugs, tasks, ideas, architecture decisions, and more. Two-tier model: inline trackers (`#bug````[...]`) stay local and personal; tracked items sync to TrackerRoom with E2E encryption. Field-level last-writer-wins conflict resolution. Client-side querying via PGLite since the server never sees searchable plaintext.

**Implementation status:** Full stack is built. Server: `TrackerRoom.ts` (626 lines) handles encrypted item storage, changelog-based delta sync, batch upsert/delete, WebSocket broadcast, hibernation recovery. Client: `TrackerSync.ts` (468 lines) with connection management, encrypted upsert/delete, field-level LWW merge, changelog cursor tracking. `TrackerSyncManager.ts` manages the sync lifecycle from Electron. `TrackerTable.tsx` overhauled with TrackerFieldEditor, TrackerDataModel enhancements. `TrackerConfigPanel.tsx` for per-type sync config. Integration tests cover upsert/broadcast, delta sync, delete/broadcast, batch operations, encryption verification, field-level LWW merge. Still needs: promotion flow (inline to tracked), per-type sync policy UI wiring, comments/activity feed.

| Document | Status | Description |
| --- | --- | --- |
| [collaborative-tracker-system.md](./collaborative-tracker-system.md) | Implemented | Full system design: TrackerRoom, sync, data models, kanban |
| [implement-tracker-room.md](./prompts/implement-tracker-room.md) | Reference | Implementation prompt for TrackerRoom DO and sync wiring |
| [unified-tracker-system-refactor.md](./../../plans/unified-tracker-system-refactor.md) | 65% | Original local tracker system (foundation for collab layer) |
| [TRACKER_EDIT_PANEL_PATTERNS_ANALYSIS.md](./TRACKER_EDIT_PANEL_PATTERNS_ANALYSIS.md) | Complete | UI patterns analysis for tracker item detail views |

### 5. Navigation & UX

How collaborative features fit into Nimbalyst's existing navigation architecture. The bottom panel was too constrained for the Linear-style tracker experience. A dedicated Tracker mode and Collab mode have been implemented.

**Implementation status:** TrackerMode is built with `TrackerMainView` (list view with search/filter, inline add), `KanbanBoard` (tracker item kanban by status), `TrackerItemDetail` (detail panel with field editing), and `TrackerSidebar` (type selection). CollabMode is built with `CollabMode.tsx` and `CollabSidebar.tsx` for shared document browsing. Both modes are wired into the `NavigationGutter` and `WindowModeTypes`. The TrackerBottomPanel has been simplified now that the full-screen mode exists. Still needs: saved filter views, assignee filters, linked document opening from tracker items.

| Document | Status | Description |
| --- | --- | --- |
| [collaboration-navigation-design.md](./collaboration-navigation-design.md) | Implemented | Tracker mode layout, document sidebar, search & filters |

### 6. Sharing (Public Links)

One-click sharing of sessions and files to Cloudflare with URL-fragment encryption keys (never sent to server). Client-side decryption in the browser for read-only viewing.

| Document | Status | Description |
| --- | --- | --- |
| [session-share-cloudflare-hosting.md](./session-share-cloudflare-hosting.md) | Done | Share AI sessions as public read-only links |
| [shared-file-viewer.md](./shared-file-viewer.md) | Draft | Share workspace files (markdown, diagrams, mockups) |

## Server Infrastructure

The collabv3 Cloudflare Worker hosts all collaboration Durable Objects. See [CLAUDE.md](./../../packages/collabv3/CLAUDE.md) for architecture details.

| Durable Object | Scope | Auth Check | Org Source | Purpose |
| --- | --- | --- | --- | --- |
| SessionRoom | per-session | userId only | personalOrgId | AI session message sync (personal) |
| IndexRoom | per-user | userId only | personalOrgId | Session index + device presence (personal) |
| DocumentRoom | per-document | userId + orgId | current orgId | Yjs CRDT state for collaborative editing |
| TrackerRoom | per-project | userId + orgId | current orgId | Encrypted tracker items with field-level LWW |
| TeamRoom | per-org | userId + orgId | current orgId | Team metadata, roles, key envelopes, doc index |

User-scoped rooms (SessionRoom, IndexRoom) do not enforce JWT orgId matching the room ID. This allows session sync to use the stable `personalOrgId` in room IDs even when the JWT is scoped to a team org after a Stytch session exchange. Org-scoped rooms (DocumentRoom, TrackerRoom, TeamRoom) enforce strict orgId matching since they hold shared team data.

## Encryption Model

All team content is encrypted client-side before transmission. The server is genuinely zero-knowledge for document and tracker content.

| Data | Encrypted? | Key Type |
| --- | --- | --- |
| Document content & edits | Yes | Per-document AES-256-GCM, ECDH-distributed |
| Tracker items | Yes | Per-project AES-256-GCM, ECDH-distributed |
| Cursor positions | Yes | Same as document key |
| Document titles (in index) | Yes | Org-level key |
| Git remote URLs | Hashed | SHA-256 (server sees hash only) |
| User IDs | No | From JWT (needed for routing) |
| Timestamps | No | Needed for sync ordering |

## Mockups

| File | Shows |
| --- | --- |
| [team-panel.mockup.html](./team-panel.mockup.html) | Team creation, member management, trust verification |
| [tracker-config-panel.mockup.html](./tracker-config-panel.mockup.html) | Tracker type configuration and sync settings |
| [tracker-mode-layout.mockup.html](./tracker-mode-layout.mockup.html) | Full-screen tracker with list/kanban views |

## Implementation Summary (2026-02-26)

The full collaborative stack has been implemented end-to-end:

| Layer | Lines | Status |
| --- | --- | --- |
| CollabV3 Server (3 DOs + REST) | ~3,300 | Complete |
| Runtime Sync Clients (5 modules) | ~2,200 | Complete |
| Electron Services + IPC (39 handlers) | ~4,500 | Complete |
| UI Components (2 modes + settings) | ~2,900 | Complete |
| Integration Tests (8 suites) | ~3,000 | Core coverage |

## Open Security Findings

From the [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) (2026-02-23):

1. ~~**P0 -- TrackerSyncManager uses personal QR seed** instead of ECDH-distributed team key.~~ **Fixed** -- TrackerSyncManager now fetches org key via ECDH envelope.
2. **P0 -- Key envelope overwrite vulnerability.** Any org member can overwrite another member's envelope. Needs authorization check in TeamRoom.
3. **P0 -- No sender validation on key envelopes.** Recipient trusts whatever public key is in the envelope without cross-checking identity_public_keys.
4. **P1 -- PBKDF2 entropy**, integrity signatures, key rotation on member removal, JWKS cache TTL, TEST_AUTH_BYPASS safety.

## What's Next

Near-term priorities (unordered):

- **Fix remaining P0 security findings** -- Add envelope authorization check, sender validation against identity_public_keys.
- **Share to Team UX** -- Polish the flow for sharing a local document to the team's CollabMode.
- **Tracker promotion flow** -- Promote inline `#bug[...]` annotations to synced tracked items.
- **Stress testing** -- 10+ concurrent users on same document/tracker, 1000+ tracker items.
- **Network resilience** -- Disconnection/reconnection testing, offline queue replay, server restart recovery.
- **camelCase wire protocol** -- Migrate WebSocket protocol from snake_case to camelCase ([camelcase-wire-protocol-migration.md](./../../plans/camelcase-wire-protocol-migration.md)).

Longer-term:

- iOS mobile collaborative editing (WKWebView + Yjs)
- Yjs compaction for growing document state
- Tracker comments and activity feed
- Session/commit linking to tracker items
- Cross-device sync verification (iOS <-> Desktop)
- Enterprise features: SSO enforcement, admin recovery keys, audit trails
