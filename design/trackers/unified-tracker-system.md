---
trackerStatus:
  type: plan
planId: pln_unified-tracker-system
title: "Unified Tracker System: Database-First with Embedded Editors"
status: in-development
planType: feature
priority: high
progress: 43
owner: ghinkle
startDate: 2026-03-04
updated: 2026-04-08
---
# Unified Tracker System: Database-First with Embedded Editors

## Problem

Nimbalyst's tracker system has three storage layers that confuse users and fragment their work:

1. **Inline markers** (`#bug[...]`) -- annotations inside documents, always local
2. **Frontmatter documents** -- standalone `.md` files with YAML metadata in `nimbalyst-local/plans/`
3. **Collaborative database** -- encrypted items synced via TrackerRoom

Users don't think in storage layers. They think "I have a bug to track" and shouldn't need to decide where it lives. The result is 250+ plan files in a flat untracked folder with no lifecycle management, no way to distinguish active work from abandoned ideas, and constant anxiety about data loss.

Additionally, the current file-based approach creates an unsolvable tension: check plans into git (noise for team) or leave them local (risk losing them). Neither is right because **tracker items aren't source code** -- they're workspace metadata that needs its own storage and lifecycle model.

## Vision

**One tracker. Database is the source of truth. Embedded Lexical editors for rich content. Sync to team when you want.**

A user should be able to:
- Create a tracker item (bug, plan, idea, task, anything) in one place
- Edit it with a full rich-text editor -- the same Lexical editor used for documents
- See all their items in a unified view with filtering, search, and lifecycle status
- Archive stale items, not delete them -- recoverable, out of sight
- Share items with their team by toggling visibility
- Have AI agents read and update tracker items through MCP tools
- Import items from external systems (Linear, GitHub Issues) and work on them locally

The mental model in one sentence: **"Your tracker items live in Nimbalyst. Share them with your team if you want."**

## Design Principles

1. **Database-first** -- PGLite is the source of truth, not files on disk
2. **Files are optional exports** -- you can export a plan to `docs/` for git, but that's a publishing action, not storage
3. **Embedded editing** -- rich content editing via Lexical inside the tracker detail panel, not by opening a separate file
4. **One unified view** -- all item types (bugs, plans, ideas, decisions, custom) in one tracker UI with filtering
5. **Lifecycle is a first-class concept** -- items have status, and archived/completed items get out of the way
6. **Agent-accessible** -- MCP tools let AI agents query, create, and update tracker items without filesystem access
7. **Gradual collaboration** -- items start private, can be shared with team. The sync layer is invisible until you need it

## Architecture

### Storage Model

```
PGLite (local database)
  tracker_items table
    - id, type, title, status, priority, tags, ...
    - content: JSONB (Lexical editor state for rich body)
    - sync_status: 'local' | 'synced' | 'pending'
    - archived: boolean
    - source: 'native' | 'inline' | 'frontmatter' | 'import'
    - source_ref: string (file path for inline/frontmatter, external ID for imports)

TrackerRoom (Cloudflare DO, encrypted)
  - Synced items only
  - Encrypted payload contains all metadata + content
  - Zero-knowledge server
```

**Key change from current design**: The `content` field stores Lexical editor state as JSONB directly in the tracker item row. No separate file. No DocumentRoom needed for tracker item content (DocumentRoom remains for collaborative document editing of workspace files).

### Content Editing

Tracker items with rich content open an **embedded Lexical editor** inside the tracker detail panel. This is the same editor used for documents, but its content source is the database row instead of a file.

```
TrackerItemDetail (existing component, enhanced)
  - Header: type icon, title, status, priority (existing)
  - Embedded LexicalEditor (new)
    - Loads content from tracker_items.content JSONB
    - Saves back to PGLite on change (debounced)
    - Full editor features: markdown, code blocks, links, images
    - If item is synced, saves trigger TrackerSyncManager update
  - Metadata: created, updated, tags, assignee, links (existing)
```

The editor uses an `EditorHost` adapter that reads/writes from PGLite instead of the filesystem. This is the same pattern AI sessions use for their content.

### Inline Marker Integration

Inline markers (`#bug``````````[...]`) remain as lightweight annotations in documents. They are indexed into PGLite as tracker items with `source: 'inline'` and appear in the unified tracker view alongside native items.

**Promotion flow**: A user can "promote" an inline marker to a native tracker item. This:
1. Creates a new native tracker item in PGLite with the inline item's metadata
2. Copies any inline description into the `content` field
3. Optionally removes the inline marker from the document (or leaves it as a reference)

### Frontmatter Migration

Existing frontmatter-based plans and decisions get a migration path:
1. **Automatic indexing** continues to work (existing behavior)
2. **Import to database** action: converts a frontmatter document into a native tracker item, moving the document's content into the `content` JSONB field
3. **Bulk migration tool**: "Import all plans from nimbalyst-local/plans/" -- scans the folder, creates native tracker items, optionally archives the files

### External Import (Linear, GitHub Issues)

**Example flow: Import Linear issues**

1. User connects Linear via MCP (already available)
2. "Import from Linear" action in tracker UI
3. Fetches issues via Linear MCP tools, creates native tracker items with:
  - `source: 'import'`
  - `source_ref: 'linear:NIM-123'`
  - Title, description, status, priority mapped from Linear fields
  - Content converted from Linear markdown to Lexical state
4. Items appear in tracker with a Linear badge showing origin
5. User works on them locally -- edits, status changes, AI sessions linked
6. **Optional sync-back**: Update Linear issue status when local item changes (future)

This works for any external system that has MCP tools or an API: GitHub Issues, Jira, Notion databases, etc. The pattern is always: import to native tracker items, work locally, optionally sync back.

## Data Model Changes

### PGLite Schema Updates

```sql
-- Add content column for rich text (Lexical editor state)
ALTER TABLE tracker_items ADD COLUMN content JSONB;

-- Add archive support
ALTER TABLE tracker_items ADD COLUMN archived BOOLEAN DEFAULT FALSE;
ALTER TABLE tracker_items ADD COLUMN archived_at TIMESTAMPTZ;

-- Add source tracking
ALTER TABLE tracker_items ADD COLUMN source TEXT DEFAULT 'native';
-- source values: 'native' (created in tracker UI), 'inline' (from #markers),
--                'frontmatter' (from YAML docs), 'import' (from external system)
ALTER TABLE tracker_items ADD COLUMN source_ref TEXT;
-- source_ref: file path for inline/frontmatter, 'linear:NIM-123' for imports

-- Index for common queries
CREATE INDEX idx_tracker_items_archived ON tracker_items(archived);
CREATE INDEX idx_tracker_items_source ON tracker_items(source);
CREATE INDEX idx_tracker_items_type_status ON tracker_items(type, status);
```

### Canonical TrackerRecord (Generic Schema Refactor)

> **Note**: The tracker system was refactored in April 2026 to be fully schema-driven.
> The old `TrackerItem` interface with hardcoded top-level fields (`title`, `status`,
> `priority`, `owner`, etc.) has been superseded by `TrackerRecord`.
> See `packages/runtime/src/core/TrackerRecord.ts` for the canonical type and
> `plans/tracker-generic-schema-refactor.md` for the full design rationale.

```typescript
interface TrackerRecord {
  id: string;
  primaryType: string;
  typeTags: string[];
  issueNumber?: number;
  issueKey?: string;
  source: 'native' | 'inline' | 'frontmatter' | 'import';
  sourceRef?: string;
  archived: boolean;
  syncStatus: 'local' | 'pending' | 'synced';
  content?: unknown;
  system: {
    workspace: string;
    documentPath?: string;
    lineNumber?: number;
    createdAt: string;
    updatedAt: string;
    lastIndexed?: string;
    authorIdentity?: TrackerIdentity | null;
    lastModifiedBy?: TrackerIdentity | null;
    createdByAgent?: boolean;
    linkedSessions?: string[];
    linkedCommitSha?: string;
    documentId?: string;
    activity?: TrackerActivity[];
    comments?: TrackerComment[];
  };
  fields: Record<string, unknown>;   // ALL user data -- schema-driven
  fieldUpdatedAt: Record<string, number>;  // Per-field LWW timestamps
}
```

Key architectural changes:
- **`fields` bag**: All user-defined business data (title, status, priority, custom fields)
  lives in `fields`. No field name is privileged -- the schema defines what exists.
- **`system` metadata**: Infrastructure fields (author, linked sessions, timestamps)
  live in `system`. These are product-internal, not user-defined.
- **Schema roles**: `TrackerDataModel.roles` maps semantic purposes to field names
  (e.g., `{ workflowStatus: 'phase', title: 'name', assignee: 'lead' }`).
  The product uses roles to find the right field without hardcoding names.
- **Frontmatter format**: `trackerStatus: { type: ... }` is the only supported
  frontmatter key. Legacy `planStatus`/`decisionStatus` keys are removed.
- **Sync payload**: Generic `{ fields, system, fieldUpdatedAt }` structure.
  No hardcoded field list in the encrypted payload.
- **MCP tools**: Accept `fields: {}` for generic field setting alongside
  conventional fixed args for backward compat.

## UI Design

### Tracker Mode (Full-Screen) -- Enhanced

The existing TrackerMode layout becomes the primary way to interact with tracker items.

**Sidebar** (existing, enhanced):
- Type filters (All, Bug, Task, Plan, Idea, Decision, custom types)
- View filters (All, Active, High Priority, Recently Updated, Archived)
- "New Item" button with type selector
- "Import" button (from files, from Linear, etc.)

**Main View** (existing, enhanced):
- Table or Kanban toggle (existing)
- Search bar (existing)
- **New**: Archive/unarchive bulk actions
- **New**: Source badges (inline, imported, etc.)

**Detail Panel** (existing, significantly enhanced):
- Header with type, title, status, priority (existing)
- **New**: Embedded Lexical editor for `content` field
  - Full-height editor below the metadata section
  - Same toolbar and features as document editor
  - Saves to PGLite, not filesystem
- Metadata section: tags, assignee, links, dates (existing)
- **New**: Linked AI sessions list
- **New**: Source info ("Imported from Linear NIM-123", "From inline marker in README.md")

### Bottom Panel -- Simplified

The bottom panel becomes a quick-glance view. Clicking an item opens Tracker Mode with the detail panel focused on that item (or opens the detail in a split view).

### Creating Items

Multiple entry points, all create native database items:
- **Tracker UI**: "New" button in tracker mode or bottom panel
- **Agent**: MCP tool `tracker_create`
- **Inline promotion**: Click action on `#bug[...]` marker
- **Import**: From external systems or from local files
- **Command palette**: "Create tracker item" command

### Archive Flow

- Items can be archived (not deleted) from the tracker UI
- Archived items disappear from default views but appear under "Archived" filter
- Bulk archive: "Archive all completed items" or "Archive items not updated in 60 days"
- Unarchive: restore from archived view
- Permanent delete: only from archived view, with confirmation

## MCP Tools for AI Agents

These tools give coding agents full access to the tracker system without needing filesystem access.

### tracker_list

```typescript
// List tracker items with filtering
{
  type?: string;          // 'bug' | 'task' | 'plan' | etc.
  status?: string;        // 'to-do' | 'in-progress' | 'done' | etc.
  priority?: string;      // 'low' | 'medium' | 'high' | 'critical'
  archived?: boolean;     // default: false
  search?: string;        // Search title and content
  limit?: number;         // default: 50
}
// Returns: Array of { id, type, title, status, priority, tags, updated }
```

### tracker_get

```typescript
// Get a single tracker item with full content
{
  id: string;             // Item ID
}
// Returns: Full TrackerItem including content (as markdown, converted from Lexical)
```

### tracker_create

```typescript
// Create a new tracker item
{
  type: string;           // 'bug' | 'task' | 'plan' | etc.
  title: string;
  description?: string;   // Plain text or markdown (converted to Lexical state)
  status?: string;        // Default: first status for the type
  priority?: string;
  tags?: string[];
}
// Returns: { id, type, title, status }
```

### tracker_update

```typescript
// Update an existing tracker item
{
  id: string;
  title?: string;
  status?: string;
  priority?: string;
  description?: string;   // Appends to or replaces content
  tags?: string[];
  archived?: boolean;
}
// Returns: Updated TrackerItem summary
```

### tracker_link_session

```typescript
// Link the current AI session to a tracker item
{
  trackerId: string;
}
// Returns: confirmation
```

**Agent workflow example:**

```
User: "Fix the bugs in the tracker"
Agent:
  1. tracker_list(type: 'bug', status: 'to-do')
  2. Sees 5 open bugs
  3. tracker_get(id: 'bug_abc') -- reads full description
  4. Fixes the code
  5. tracker_update(id: 'bug_abc', status: 'done')
  6. tracker_link_session(trackerId: 'bug_abc')
```

## Collaboration & Sync

### How Sync Works (Unchanged Architecture)

The existing TrackerRoom/TrackerSyncManager architecture remains. The key addition is that the `content` field (Lexical editor state) is included in the encrypted payload synced to TrackerRoom.

- **Local items** (`sync_status: 'local'`): PGLite only, never leaves the machine
- **Synced items** (`sync_status: 'synced'`): Encrypted and synced to TrackerRoom, visible to team
- **Pending items** (`sync_status: 'pending'`): Queued for sync (offline support)

### Sharing Flow

1. User creates item (defaults to `local`)
2. User toggles "Share with team" in detail panel
3. Item encrypted with team ECDH key, sent to TrackerRoom
4. Team members see item appear in their tracker
5. Changes sync bidirectionally in real-time

### Content Collaboration

When a synced item's content is edited:
- LWW at the content-field level (not character level)
- For collaborative editing of a single item's content simultaneously, we could link to a DocumentRoom (Phase 6 from original design), but this is a stretch goal
- For most team use cases, LWW on the whole content blob is sufficient (people rarely co-edit a bug description simultaneously)

## Implementation Phases

### Phase 1: Database Content & Embedded Editor

**Goal**: Tracker items can have rich content stored in PGLite, edited with embedded Lexical.

- [x] Add `content JSONB` column to `tracker_items` table
- [x] Add `archived`, `archived_at`, `source`, `source_ref` columns
- [x] IPC handlers for content read/write and archive operations (replaces TrackerEditorHost)
- [x] Embed Lexical editor in TrackerItemDetail panel
- [x] Wire up debounced saves from editor to PGLite
- [x] "New Item" creation flow that creates native database items (already existed, extended with new fields)
- [x] Basic archive/unarchive UI

### Phase 2: Migration from File-Based Plans

**Goal**: Existing plan files can be imported into the database.

- [x] "Import plan from file" action (single file via IPC)
- [x] Bulk import: "Import all from nimbalyst-local/plans/" (and other directories)
  - Reads frontmatter metadata + markdown content
  - Stores markdown body as content in JSONB column
  - Creates native tracker items with `source: 'frontmatter'`
  - Preserves original file path in `source_ref`
- [x] Import progress UI (status toast with count, skipped, errors)
- [ ] Post-import: option to archive/delete source files

### Phase 3: MCP Tools for Agent Access

**Goal**: AI agents can fully interact with the tracker system.

- [x] `tracker_list` MCP tool with filtering
- [x] `tracker_get` MCP tool (returns content as markdown)
- [x] `tracker_create` MCP tool
- [x] `tracker_update` MCP tool
- [x] `tracker_link_session` MCP tool
- [x] Register tools in internal MCP server (nimbalyst-mcp)
- [x] Custom widget for tracker tool results in chat transcript

### Phase 4: External Import (Linear Integration)

**Goal**: Import issues from Linear and work on them in Nimbalyst.

- [ ] "Import from Linear" action in tracker UI
- [ ] Linear issue -> TrackerItem field mapping:
  - Linear state -> tracker status
  - Linear priority (1-4) -> tracker priority
  - Linear labels -> tracker tags
  - Linear description (markdown) -> Lexical content
  - Linear identifier (e.g., NIM-123) -> source_ref
- [ ] Import selection UI: pick project, filter by state, select items
- [ ] Source badge in tracker UI showing Linear origin
- [ ] Bi-directional status sync (stretch goal):
  - When local item status changes, update Linear via MCP
  - Configurable: off, manual push, auto-sync

### Phase 5: Inline Marker Promotion

**Goal**: Inline `#bug[...]` markers can be promoted to full tracker items.

- [ ] "Promote to tracker" action on inline marker popover
- [ ] Creates native item from inline metadata
- [ ] Copies description (indented lines) to content field
- [ ] Option to remove inline marker from document or leave as reference
- [ ] Promoted items show link back to source document

### Phase 6: Enhanced Lifecycle & Views

**Goal**: Rich lifecycle management for at-scale tracker usage.

- [ ] Saved custom views (filter + sort combinations)
- [ ] Bulk actions: archive completed, archive stale (>N days), change status
- [ ] "Activity" timeline on items (status changes, edits, session links)
- [ ] Dashboard view: counts by type/status, recently active, stale items
- [ ] Export to markdown (single item or filtered set) for git/docs

### Phase 7: Team Sync for Content

**Goal**: Synced tracker items include rich content in encrypted payload.

- [ ] Include `content` field in TrackerSyncProvider encryption
- [ ] Content-level LWW merge (whole content blob, not per-character)
- [ ] Fix P0 encryption issues (wrong key, envelope overwrites, sender verification)
- [ ] Team member avatars on assigned items
- [ ] Sync status indicator in detail panel

## Security Prerequisites (from Existing Design)

Before shipping team sync, these P0 issues must be resolved:

1. **TrackerSyncManager uses wrong encryption key** -- currently uses personal QR seed instead of ECDH-distributed per-project key
2. **Key envelope overwrite vulnerability** -- any org member can overwrite another user's key envelope
3. **No sender verification on key envelopes** -- recipient trusts senderPublicKey without validation

These are documented in the existing `collaborative-tracker-system.md` design and block Phase 7.

## What This Replaces

| Current | New |
| --- | --- |
| 250 plan files in `nimbalyst-local/plans/` | Database rows with embedded Lexical editors |
| Flat folder with no lifecycle | Kanban/table with status, filters, archive |
| Untracked, easily lost | PGLite database (backed up via sync when shared) |
| "Should I git commit this?" | Not a git artifact. Export to git when you want to publish |
| Agents read plan files from disk | Agents use MCP tools to query tracker |
| Separate inline/file/database worlds | One unified tracker view, source is a detail |

## Decisions

1. **Solo backup: Deferred** -- Not a priority. Focus on the core tracker experience first. Solo backup (personal sync tier, local export, etc.) can come after team sync is proven.
2. **Linear import: One-way only** -- Pull issues into Nimbalyst, work on them locally. Nimbalyst becomes the source of truth for imported items. No sync-back to Linear. This keeps the import simple and avoids conflict resolution complexity.
3. **Mobile tracker: Deferred** -- Mobile (iOS) focuses on AI sessions for now. Tracker is a desktop experience until the core database-first model is solid.
4. **Custom tracker types: Visual UI + YAML escape hatch** -- Ship a visual type builder in settings for simple cases (name fields, pick statuses, set colors). Keep YAML support for power users and AI-generated configurations. Ship common templates (blog post, architecture decision record, sprint goal) that can be customized.

## Open Questions

1. **Conflict UX for synced content** -- When LWW overwrites someone's content edit, should we show a notification? Keep a version history?
2. **Plan document backlinks** -- If a plan references code files, should those files show a backlink indicator in the file tree?
