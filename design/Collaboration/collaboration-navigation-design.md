---
planStatus:
  planId: plan-collaboration-navigation-design
  title: Collaboration Navigation & Layout Design
  status: implemented
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders:
    - development-team
  tags:
    - collaboration
    - navigation
    - tracker
    - documents
    - ui
    - architecture
  created: "2026-02-23"
  updated: "2026-02-26T00:00:00.000Z"
  progress: 80
---

# Collaboration Navigation & Layout Design

How trackers, shared documents, and collaborative features fit into Nimbalyst's navigation architecture. The bottom panel is too constrained for the Linear-style experience we want. This doc explores adding a Tracker mode and integrating shared documents.

## Current Architecture

```
NavigationGutter (48px)     Main Content Area
┌──────┐ ┌──────────────────────────────────────────────┐
│      │ │                                              │
│ Files│ │  EditorMode (file tree + tabs + editors)     │
│      │ │                                              │
│ Agent│ │  AgentMode  (sessions + chat + files edited) │
│      │ │                                              │
│ .... │ │  SettingsView                                │
│      │ │                                              │
│ Term │ ├──────────────────────────────────────────────┤
│ Track│ │  TrackerBottomPanel (resizable, 200-800px)   │
│      │ │  or TerminalBottomPanel (mutually exclusive) │
│      │ │                                              │
│ ⚙Set │ │                                              │
└──────┘ └──────────────────────────────────────────────┘
```

**Modes**: Files, Agent, Settings (controlled by `windowModeAtom`)
**Bottom panels**: Tracker, Terminal (mutually exclusive, toggle from gutter)
**Left sidebar**: WorkspaceSidebar with FlatFileTree + filters (no sections/tabs concept)

## The Problem

The bottom panel works for quick triage -- glance at a few bugs while editing. But for serious project management it's too cramped:

- **No room for kanban**: Horizontal columns need full width, not a 200-800px strip
- **No room for detail views**: Clicking a tracker item should open a rich view, not a tiny popover
- **No search/filter bar**: Need quick search, saved views, assignee filters
- **Can't see linked documents**: A Plan tracker item should open its collaborative document in-context
- **Shared documents have no home**: If Alice shares a doc with the team, where does Bob find it?

## Design: Tracker Mode

Add a third content mode to the nav gutter, below Agent. This is a full-screen experience like Linear, not a panel.

```
NavigationGutter          Main Content Area (Tracker Mode active)
┌──────┐ ┌───────────────────────────────────────────────────────────┐
│      │ │  ┌──────────────┐ ┌────────────────────────────────────┐ │
│ Files│ │  │ Tracker      │ │                                    │ │
│      │ │  │ Sidebar      │ │  Main View                        │ │
│ Agent│ │  │              │ │                                    │ │
│      │ │  │ ───────────  │ │  Table / Kanban / Detail           │ │
│▸Track│ │  │ Bugs     14  │ │                                    │ │
│      │ │  │ Tasks    23  │ │  ┌──────────────────────────────┐  │ │
│      │ │  │ Plans     8  │ │  │ Search + Filters + View Mode │  │ │
│      │ │  │ Features  5  │ │  ├──────────────────────────────┤  │ │
│      │ │  │ Ideas    12  │ │  │                              │  │ │
│      │ │  │              │ │  │  [table rows or kanban cols]  │  │ │
│      │ │  │ ───────────  │ │  │                              │  │ │
│      │ │  │ Views        │ │  │                              │  │ │
│      │ │  │  My Items    │ │  │                              │  │ │
│      │ │  │  Triage      │ │  │                              │  │ │
│      │ │  │  Active      │ │  │                              │  │ │
│      │ │  │              │ │  └──────────────────────────────┘  │ │
│      │ │  │ ───────────  │ │                                    │ │
│ Term │ │  │ Docs         │ │  ┌──────────────────────────────┐  │ │
│      │ │  │  Arch Plan   │ │  │ Detail Panel (split/overlay)  │  │ │
│      │ │  │  API Spec    │ │  │ or opens in editor tab         │  │ │
│ ⚙Set │ │  │  RFC: Auth   │ │  └──────────────────────────────┘  │ │
│      │ │  └──────────────┘ └────────────────────────────────────┘ │
└──────┘ └───────────────────────────────────────────────────────────┘
```

### Tracker Sidebar (left)

**Sections:**

1. **Tracker Types** -- Each type from `.nimbalyst/trackers/*.yaml` is a nav item with count badge. Clicking one shows that type's items in the main view.
   - Bugs (14)
   - Tasks (23)
   - Plans (8)
   - Feature Requests (5)
   - Tech Debt (6)
   - Feedback (3)
   - Shared items show a subtle sync icon; local-only types are visually distinct

2. **Views** -- Saved filter presets (like Linear's "My Issues", "Active", "Backlog")
   - My Items (assigned to me)
   - Triage (unassigned, high priority)
   - Active Sprint / Active (in-progress items across all types)
   - Custom saved views

3. **Shared Docs** -- Team documents not tied to a specific tracker item. This gives shared documents a browsable home.
   - Architecture Plan
   - API Specification
   - RFC: Auth Redesign
   - These are DocumentRoom-backed collaborative files

### Main View (right)

**View modes** (toggled in toolbar):
- **Table** -- Dense sortable/filterable table (current TrackerTable, upgraded)
- **Kanban** -- Columns by status, drag-and-drop
- **Board** -- Future: swimlanes by assignee or priority

**Toolbar:**
- Quick search (filters items as you type)
- Filter chips (status, priority, assignee, label)
- View mode toggle (table / kanban)
- New Item button

**Detail view**: Clicking a tracker item opens its detail. Two options:

- **Option A: Split pane** -- Detail opens in a right panel within Tracker mode. Good for quick edits without losing context.
- **Option B: Editor tab** -- Detail opens as a tab in Files mode (like how clicking a file in Agent mode opens it in Files). Good for full editing with Lexical.
- **Recommendation: Both.** Single-click opens split pane detail in Tracker mode. Double-click (or "Open in Editor") opens as a tab in Files mode. This matches how Linear works -- quick detail inline, full view in new window.

### Where Shared Documents Live

This is the key question. A shared document (like an architecture plan) needs to be findable from two places:

**1. From the Tracker sidebar (Docs section)**

The Tracker sidebar has a "Docs" section listing team documents. Clicking one opens it in the main view area (rendered with the Lexical collaborative editor). This is the discovery path -- "what docs does our team have?"

**2. From the Files mode sidebar**

The Files mode file tree gains a new filter option: **"Shared"** (alongside existing filters like "All", "Markdown", "Git Uncommitted", etc.). When "Shared" is selected, the file tree shows collaborative documents from the team's DocumentRooms instead of local filesystem files.

Alternatively (and probably better): a **toggle** at the top of the file tree between "Local Files" and "Team Files". This is more discoverable than burying it in the filter menu.

**3. Linked from tracker items**

When a Plan or Bug has a `documentId`, the tracker detail view shows a "View Document" link. Clicking it opens the collaborative document -- either in the Tracker mode's main view (split pane) or as a Files mode tab.

### The Relationship: Tracker Items and Documents

```
Tracker Item (metadata in TrackerRoom)
├── type: plan
├── title: "Architecture Redesign"
├── status: in-review
├── assignee: alice
├── documentId: "doc-abc123"  ──────┐
└── ...                              │
                                     ▼
                          DocumentRoom "doc-abc123"
                          ├── Collaborative Yjs document
                          ├── Real-time editing with cursors
                          ├── E2E encrypted
                          └── Review gate for remote edits
```

- **Simple items** (bugs with just title + description): All content in TrackerRoom encrypted payload. Detail view shows inline form.
- **Rich items** (plans, specs, RFCs): Thin metadata in TrackerRoom + full document in DocumentRoom. Detail view shows embedded Lexical editor with collaboration.
- **Standalone docs** (shared but not tracked): DocumentRoom only, no tracker item. Appears in Docs section and Shared files filter.

## What Happens to the Bottom Panel?

The bottom panel doesn't go away -- it becomes **quick-access triage**. When you're in Files mode editing code and want to glance at open bugs, the bottom panel is still there. It's a lightweight view of the same data.

Think of it like: Tracker mode is "Linear", bottom panel is "the GitHub Issues sidebar in VS Code."

```
Bottom panel: Quick reference while coding (stays as-is)
Tracker mode: Full project management experience (new)
```

The bottom panel and Tracker mode share the same data source (PGLite + TrackerRoom sync), just different views.

## Navigation Gutter Changes

Current gutter order:
1. Files
2. Agent
3. (extension panels)
4. (spacer)
5. Terminal toggle
6. Tracker toggle
7. Settings

New gutter order:
1. Files
2. Agent
3. **Tracker** (new content mode, replaces tracker bottom panel toggle)
4. (extension panels)
5. (spacer)
6. Terminal toggle
7. Settings

The Tracker gutter button changes from a bottom-panel toggle to a content mode button (like Files and Agent). The bottom panel still exists but is toggled differently -- perhaps a small button within Files/Agent mode, or auto-shown with a keyboard shortcut.

## Files Mode: Shared Virtual Filesystem

The file tree sidebar in Files mode gains a toggle between the local workspace filesystem and a shared virtual filesystem backed by DocumentRooms and a folder index. This is not a flat document list -- it's a real filesystem with folders, nested structure, and per-folder permissions.

### The Toggle

```
┌──────────────────────┐
│ ◉ Local   ○ Shared   │  ← segmented control
├──────────────────────┤
│ 📁 src/              │
│ 📁 packages/         │
│ 📄 README.md         │
│ 📄 CLAUDE.md         │
│ ...                  │
└──────────────────────┘
```

When "Shared" is selected, the file tree renders the team's shared folder tree:

```
┌──────────────────────┐
│ ○ Local   ◉ Shared   │
├──────────────────────┤
│ 📁 Architecture      │  ← folder (collapsed)
│ 📁 RFCs              │  ← folder (collapsed)
│ 📂 Specs             │  ← folder (expanded)
│   📝 API Spec v2     │
│   📝 Auth Protocol   │
│   📁 Deprecated      │  ← nested subfolder
│ 📂 Meeting Notes     │
│   📝 2/21 Standup    │
│   📝 2/24 Sprint     │
│ 📝 Onboarding Guide  │  ← root-level doc
│                      │
│ + New Document       │
│ + New Folder         │
└──────────────────────┘
```

This is a **real tree** with the same UX affordances as the local file tree:
- Expand/collapse folders by clicking
- Drag documents between folders
- Right-click context menu: Rename, Move, Delete, Share Settings
- Create new documents and folders inline
- Keyboard navigation (arrow keys, Enter to open)

The tree data comes from a **FolderIndex** -- a Durable Object or D1 table that stores the folder/document hierarchy for a team. The tree is E2E encrypted: the server stores encrypted folder names, encrypted document titles, and encrypted parent-child relationships. Only team members with the folder key can see the structure.

### Shared File Tree Data Model

Every node in the shared tree is either a **folder** or a **document reference**. Documents are backed by DocumentRooms; folders are organizational containers with their own encryption keys.

```
SharedTreeNode
├── id: string (UUID)
├── parentId: string | null (null = root)
├── type: 'folder' | 'document'
├── encryptedName: string (AES-GCM ciphertext of display name)
├── sortOrder: number (for manual ordering within a folder)
├── createdBy: string (userId)
├── createdAt: string (ISO)
├── updatedAt: string (ISO)
│
├── [if type = 'folder']
│   └── keyId: string (references the folder's AES key in the key envelope system)
│
└── [if type = 'document']
    ├── documentRoomId: string (the DocumentRoom DO this doc lives in)
    └── documentType: string ('markdown' | 'datamodel' | 'excalidraw' | etc.)
```

### FolderIndex Durable Object

A new DO type that stores the folder tree for a team. One FolderIndex per org.

Room ID format: `org:{orgId}:folder-index`

```sql
-- Folder tree nodes
CREATE TABLE tree_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT,                    -- null = root level
  node_type TEXT NOT NULL,           -- 'folder' | 'document'
  encrypted_name BLOB NOT NULL,      -- AES-GCM(folderKey, name)
  name_iv TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Document-specific fields (null for folders)
  document_room_id TEXT,
  document_type TEXT,

  -- Folder-specific fields (null for documents)
  key_id TEXT,                       -- references key envelope for this folder's key

  FOREIGN KEY (parent_id) REFERENCES tree_nodes(id) ON DELETE CASCADE
);

CREATE INDEX idx_tree_parent ON tree_nodes(parent_id);
CREATE INDEX idx_tree_doc_room ON tree_nodes(document_room_id);
```

**Sync protocol**: The FolderIndex uses the same append-only encrypted message pattern as other DOs. Clients receive the full tree on connect, then incremental updates (node created, moved, renamed, deleted) as they happen. Changes are broadcast to all connected team members.

```typescript
// Client -> Server
type FolderClientMessage =
  | { type: 'folderSyncRequest' }
  | { type: 'createNode'; node: EncryptedTreeNode }
  | { type: 'moveNode'; nodeId: string; newParentId: string | null; sortOrder: number }
  | { type: 'renameNode'; nodeId: string; encryptedName: string; nameIv: string }
  | { type: 'deleteNode'; nodeId: string }

// Server -> Client
type FolderServerMessage =
  | { type: 'folderSyncResponse'; nodes: EncryptedTreeNode[] }
  | { type: 'nodeCreated'; node: EncryptedTreeNode }
  | { type: 'nodeMoved'; nodeId: string; newParentId: string | null; sortOrder: number }
  | { type: 'nodeRenamed'; nodeId: string; encryptedName: string; nameIv: string }
  | { type: 'nodeDeleted'; nodeId: string }
  | { type: 'error'; code: string; message: string }
```

### Permission Model: Per-Folder Encrypted Keys

Permissions in the shared filesystem are **key-based**. If you have a folder's AES key, you can decrypt its contents (child names, documents). If you don't have the key, those nodes are opaque blobs.

**Key hierarchy:**

```
Team Root Key (distributed via team key envelopes, all members get this)
├── encrypts: root-level folder names and root-level document names
│
├── /Architecture/ folder key (derived or independent)
│   ├── encrypts: folder name, child names
│   └── distributed to: alice, bob, charlie
│
├── /RFCs/ folder key
│   ├── encrypts: folder name, child names
│   └── distributed to: all team members (inherits root key)
│
├── /Specs/ folder key
│   ├── encrypts: folder name, child names
│   ├── distributed to: alice, bob
│   │
│   └── /Specs/Deprecated/ subfolder key
│       ├── encrypts: subfolder name, child names
│       └── distributed to: alice only (restricted)
│
└── Document keys (per-DocumentRoom, independent of folder keys)
    ├── "API Spec v2" document key -> distributed to anyone with /Specs/ folder key
    └── "Onboarding Guide" document key -> distributed to all team members
```

**Two levels of access:**

1. **Folder visibility**: Can you see this folder exists and see its children's names? Requires the **folder key**.
2. **Document access**: Can you open and edit this document? Requires the **document key** (per-DocumentRoom, same as existing ECDH key envelope system).

This separation means:
- You can see a document title in the tree without being able to open it (you have the folder key but not the document key)
- An admin can grant someone visibility into a folder structure without granting access to every document in it
- Revoking folder access hides the entire subtree, even if the user still has individual document keys (they can still access those docs via direct link/tracker, just not browse to them)

**Permission inheritance:**

By default, folder keys cascade. When you create a subfolder, it inherits the parent's key -- meaning anyone who can see the parent can see the child. To restrict access, an admin generates a new independent key for the subfolder and distributes it to a subset of users.

```
Default (inherited):
  /Specs/ key = parent key -> all parent-key holders see /Specs/
  /Specs/API.md document key -> separate, but typically distributed to same group

Restricted:
  /Specs/Deprecated/ key = NEW independent key
  Only distributed to: alice
  Bob can see /Specs/ but not /Specs/Deprecated/
```

**Key inheritance implementation:**

```typescript
interface FolderKeyConfig {
  // If inheritParentKey is true, this folder uses the parent's AES key
  // (or the team root key if at root level). No separate key envelope needed.
  inheritParentKey: boolean;

  // If inheritParentKey is false, this folder has its own AES key
  // distributed via key envelopes to specific users.
  keyId?: string;  // references key_envelopes table
}
```

Most folders inherit. Only folders that need restricted access get their own key. This keeps the key envelope count manageable -- you only create extra envelopes for the restricted folders, not for every folder in the tree.

**Server-side enforcement:**

The FolderIndex DO stores all nodes (encrypted). The server cannot filter by permission since it can't read the encrypted names. Instead, the client receives all nodes and decrypts only the ones it has keys for. Undecryptable nodes are hidden from the UI.

This is the same zero-trust model as DocumentRoom -- the server is a dumb relay. Permission enforcement happens client-side through key distribution.

For operations (create, move, delete), the server validates:
- The caller is a team member (JWT auth)
- The parent node exists (referential integrity)
- The node being moved/deleted exists

The server does NOT validate permission to a specific folder -- it can't, since folder membership is encrypted. A malicious client with team membership could theoretically create nodes in folders they shouldn't access. This is acceptable because:
1. They can't decrypt the folder's existing contents without the key
2. Their created node would be encrypted with a key other team members already have (the folder key), so existing members could see the rogue node
3. Audit trail (created_by) identifies the actor
4. Admin can delete rogue nodes

For higher-security environments, a future enhancement could add server-side access control lists (unencrypted ACL alongside encrypted content), trading some metadata privacy for server-enforced permissions.

### Opening Shared Documents

Clicking a document in the shared tree creates a **`collab://` tab** (same as defined in the [Document Collaboration design](./realtime-document-collaboration.md#tab-identity-collab-uri-scheme)):

```
collab://org:{orgId}:doc:{documentRoomId}
```

The tab:
- Connects a DocumentSyncProvider to the document's room
- Binds Lexical to the Y.Doc via `@lexical/yjs createBinding()`
- Shows collaborative cursors, awareness indicators
- Applies the review gate for remote edits (multi-user mode)
- Tab title shows the decrypted document name from the folder tree

The shared file tree provides **discovery** (browse and find documents). The `collab://` tab system provides **editing** (open and work on them). Same document, different concerns.

### Creating Documents and Folders

**New Document** (from shared tree context menu or bottom button):
1. Client generates a new DocumentRoom ID (UUID)
2. Client creates a `tree_node` with `type: 'document'` and the new room ID
3. Folder key encrypts the document name in the tree node
4. A new per-document AES key is generated and wrapped for all users who have the parent folder key
5. The document tab opens immediately (empty Y.Doc)

**New Folder** (from shared tree context menu or bottom button):
1. Client creates a `tree_node` with `type: 'folder'`
2. By default, `inheritParentKey: true` -- no new key envelopes needed
3. If the user wants to restrict access, they can "Lock Folder" from context menu, which generates an independent key and prompts to select who should have access

**Promote Local File to Shared** (from local file tree context menu):
1. User right-clicks a local `.md` file -> "Share with Team"
2. Client reads the file content, creates a new DocumentRoom + tree node
3. Pushes the file content as the initial Y.Doc state
4. Optionally removes the local file (or keeps it as an unlinked copy)
5. The file now lives in the shared tree, editable by team members

### Why Both Tracker Sidebar Docs AND Shared File Tree?

Different entry points for different workflows:
- **Tracker mode Docs section**: "I'm doing project management. What team docs exist?" -- a flat list filtered to documents linked to tracker items, sorted by recency
- **Files mode Shared tree**: "I'm coding and need to reference the API spec. Let me browse to it." -- full hierarchical navigation with folders

Same underlying data (DocumentRooms), different views. The Tracker sidebar shows documents by relevance to tracked work. The shared file tree shows documents by organizational hierarchy. Like how you can find a file in VS Code from the explorer, Quick Open, or a terminal command.

## Implementation Phases

Phases are ordered by dependency chain, not by feature area. `collab://` tabs are the critical path -- both the shared file tree and tracker docs need them to open documents.

```
Build Order (dependency graph):

Phase 1-3: Tracker Mode ........................... DONE
Phase 4: collab:// tab infrastructure ────────┐
Phase 5: FolderIndex DO (parallel with 4) ──┐ │
                                             ├─┼─> Phase 6: Shared Tree UI
Phase 7: Tracker sidebar docs (needs 4) <────┘ │
Phase 8: Folder permissions (needs 6) <─────────┘
Phase 9: Saved views (independent, low priority)
Phase 10: Promote local to shared (needs 4+6)
```

### Phase 1: Tracker Mode Shell -- DONE
- [x] Add 'tracker' to `ContentMode` type in `WindowModeTypes.ts`
- [x] Add gutter button with `assignment` icon and Cmd+Shift+T shortcut
- [x] Create `TrackerMode` component (sidebar + main view layout)
- [x] `TrackerSidebar` with type list (reads from `globalRegistry`), count badges via `trackerItemCountByTypeAtom`
- [x] `TrackerMainView` renders TrackerTable with search/filter toolbar
- [x] Persisted layout state via `trackerModeLayoutAtom` (selected type, view, view mode)
- [x] Bottom panel remains as secondary quick-access

### Phase 2: Enhanced Table + Kanban -- DONE
- [x] TrackerTable with search bar, filter chips, column sorting
- [x] `KanbanBoard` component with status columns
- [x] View mode toggle in toolbar (table / kanban)
- [x] Drag-and-drop status changes in kanban

### Phase 3: Detail View -- DONE
- [x] `TrackerItemDetail` split pane within Tracker mode
- [x] `TrackerFieldEditor` for inline field editing
- [x] `selectedItemId` in `TrackerModeLayout` atom
- [x] Single-click in table/kanban opens detail pane

### Phase 4: Desktop Editor Integration (collab:// tabs)
**Critical path.** Everything that opens a collaborative document needs this. This is Phase 6 of the [Document Collaboration design](./realtime-document-collaboration.md#phase-6-desktop-editor-integration), brought forward because it unblocks the shared file tree, tracker docs, and promote-to-shared flows.

**Depends on**: DocumentSync (DONE), DocumentRoom DO (DONE)
**Unblocks**: Phases 6, 7, 10

- `collab://` URI scheme handling in TabsContext, TabContent, TabManager
- `CollaborativeEditorHost` implementation wrapping DocumentSyncProvider
- Lexical-Yjs binding via `@lexical/yjs createBinding()`
- Tab display: collaboration icon, document title from metadata, connection status
- Skip file watcher, autosave timer, and save-to-disk for `collab://` tabs
- Review gate diff UI for remote and agent edits
- Awareness UI: remote cursors, connected collaborators in header
- Agent MCP tools: `read_collab_doc`, `edit_collab_doc`, `list_collab_docs`

### Phase 5: FolderIndex Durable Object
Server-side infrastructure for the shared virtual filesystem. **Can be built in parallel with Phase 4** -- pure server-side, no desktop dependencies.

**Depends on**: nothing (follows existing DO patterns)
**Unblocks**: Phase 6

- Create `FolderIndex.ts` Durable Object with `tree_nodes` SQLite table
- Wire into collabv3 routing: `org:{orgId}:folder-index`
- Implement sync protocol: `folderSyncRequest`, `createNode`, `moveNode`, `renameNode`, `deleteNode`
- Broadcast node changes to all connected clients
- Folder key inheritance: `inheritParentKey` flag on folder nodes
- Integration tests: tree CRUD, move operations, concurrent modifications, cascade delete

### Phase 6: FolderIndex Client + Shared Tree UI
Desktop client for browsing and managing the shared filesystem. The big visible deliverable -- the Local/Shared toggle in Files mode.

**Depends on**: Phase 4 (collab:// tabs, to open docs), Phase 5 (FolderIndex DO, to get the tree)
**Unblocks**: Phases 7, 8, 10

- `FolderIndexProvider` in `packages/runtime/src/sync/` -- connects to FolderIndex DO, decrypts tree, maintains local state
- `SharedFileTree` component in Files mode -- renders the decrypted folder tree with same UX as `FlatFileTree` (expand/collapse, context menu, keyboard nav)
- Local/Shared segmented control toggle at top of `WorkspaceSidebar`
- Tree node decryption: attempt decrypt with available folder keys, hide undecryptable nodes
- Context menu: New Document, New Folder, Rename, Move, Delete, Share Settings (for folder key management)
- Create document flow: generate DocumentRoom ID, create tree node, open `collab://` tab
- Create folder flow: create tree node, inherit parent key by default
- Drag-and-drop: move documents between folders, reorder
- Persisted expansion state in workspace settings

### Phase 7: Shared Documents in Tracker Sidebar
Connect the Tracker sidebar to shared documents. Lighter lift than the shared tree -- just a flat list of docs linked from tracker items.

**Depends on**: Phase 4 (collab:// tabs, to open docs). Does NOT need Phase 5/6 (no folder browsing, just direct document links).

- "Docs" section in Tracker sidebar: flat list of recently active shared documents
- Documents linked from tracker items via `documentId` field
- Click doc in Tracker sidebar -> opens `collab://` tab (stays in Tracker mode or switches to Files)
- "Link Document" action on tracker items -> opens document picker (from shared tree if Phase 6 is done, else simple ID input)
- Create new shared document directly from tracker item detail view

### Phase 8: Folder Permissions UI
Per-folder access control for restricting visibility. Not needed for initial launch -- start with all folders using the team root key (everyone sees everything). Add this when teams need confidential subfolders.

**Depends on**: Phase 6 (shared tree must work end-to-end first)

- "Lock Folder" context menu action: generates independent folder key, opens member picker
- Key distribution: wrap new folder key for selected users via ECDH envelopes
- Visual indicators: lock icon on restricted folders, "N members" badge
- Inherited vs independent key display in folder properties
- "Manage Access" dialog: add/remove members from a restricted folder
- Cascade behavior: restricting a parent folder hides the entire subtree from non-members

### Phase 9: Saved Views
Lower priority -- existing views (All, High Priority, Recently Updated) are functional. Custom saved views are polish.

**Depends on**: nothing (independent of collaboration work)

- "My Items", "Triage", "Active" preset views
- Custom saved view creation (filter + sort + view mode)
- Views listed in Tracker sidebar

### Phase 10: Promote Local File to Shared
Bridge between local workspace and shared filesystem.

**Depends on**: Phase 4 (collab:// tabs), Phase 6 (shared tree for destination picker)

- "Share with Team" in local file tree context menu
- Creates DocumentRoom + tree node, pushes file content as initial Y.Doc state
- Option to keep local copy or remove it
- Reverse: "Save Local Copy" from shared document context menu

## Open Questions

1. ~~**Tracker mode icon**~~: **Resolved.** Using `assignment` Material Symbol. Already wired in NavigationGutter.

2. **Bottom panel fate**: Keep it as quick-access triage? Remove it once Tracker mode exists? Or convert it to show "pinned" items?

3. ~~**Keyboard shortcut**~~: **Resolved.** Cmd+Shift+T for Tracker mode. Already wired.

4. **Mobile**: Does the iOS app get a shared file browser? Probably yes eventually (WebView-based, same as document editing), but desktop-first.

5. ~~**Standalone shared docs**~~: **Resolved.** Yes. Documents can exist in the shared tree without any tracker item. Useful for meeting notes, RFCs, onboarding docs, etc.

6. **Document types in shared**: Start with markdown (Lexical/Yjs). Excalidraw has native Yjs support so it's a natural next candidate. DataModelLM and code files later.

7. **FolderIndex compaction**: The tree itself is small (hundreds of nodes, not millions), so compaction may not be needed. If it is, use the same client-driven snapshot approach as DocumentRoom.

8. **Conflict resolution for tree operations**: Two users creating a node with the same name in the same folder simultaneously. Use LWW (last-writer-wins) by timestamp -- both nodes are created, one may shadow the other. Client can show both and let the user resolve. Alternatively, allow duplicate names (like a real filesystem).

9. **Offline tree operations**: If a user creates/moves/deletes nodes while offline, buffer the operations and replay on reconnect. The FolderIndex DO handles conflicts via LWW on sequence numbers.

10. **Shared tree search**: Quick Open (Cmd+P) should search shared documents alongside local files when in Shared mode. Needs a search index of decrypted document names.

## Dependencies

- **Requires**: [Team Management & Trust UI](./team-management-trust-ui.md) (team membership + ECDH keys) -- COMPLETE
- **Requires**: TrackerSyncService (collaborative tracker sync) -- COMPLETE
- **Requires**: DocumentSync (client-side Yjs + encryption) -- COMPLETE
- **Requires**: FolderIndex DO (Phase 5 of this plan) -- NOT STARTED
- **Requires**: `collab://` tab infrastructure (Phase 9 / Document Collaboration Phase 6) -- NOT STARTED
- **Enables**: Full collaborative workspace with organized shared documents and granular access control

[Tracker Mode Layout](design/Collaboration/tracker-mode-layout.mockup.html)
