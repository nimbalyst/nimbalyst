/**
 * Platform-agnostic document service interface for listing and managing documents
 */

export interface Document {
  id: string;
  name: string;
  path: string;
  workspace?: string;
  lastModified?: Date;
  type?: string;
  size?: number;
}

export interface DocumentOpenOptions {
  path?: string;
  name?: string;
}

/**
 * Metadata entry for a document's frontmatter and derived attributes
 */
export interface DocumentMetadataEntry {
  id: string;           // matches Document.id
  path: string;         // relative path within workspace
  workspace?: string;
  frontmatter: Record<string, unknown>;
  summary?: string;     // AI generated summary (if present in frontmatter)
  tags?: string[];      // convenience extraction for common fields
  lastModified: Date;   // from filesystem mtime
  lastIndexed: Date;    // when cache parsed frontmatter
  hash?: string;        // frontmatter sha hash
  parseErrors?: string[]; // warnings captured during parsing
}

/**
 * Event emitted when metadata changes
 */
export interface MetadataChangeEvent {
  added: DocumentMetadataEntry[];
  updated: DocumentMetadataEntry[];
  removed: string[];    // Just IDs for removed entries
  timestamp: Date;
}

/**
 * Tracker item types
 */
export type TrackerItemType = 'bug' | 'task' | 'plan' | 'idea' | 'decision' | 'feature' | (string & {});
export type TrackerItemStatus = 'to-do' | 'in-progress' | 'in-review' | 'done' | 'blocked' | 'proposed' | 'in-discussion' | 'decided' | 'implemented' | 'rejected' | 'superseded' | (string & {});
export type TrackerItemPriority = 'low' | 'medium' | 'high' | 'critical';
export type TrackerItemSyncStatus = 'local' | 'synced' | 'pending';

/** Source of a tracker item: how it was created */
export type TrackerItemSource = 'native' | 'inline' | 'frontmatter' | 'import';

/**
 * Pointer to the upstream record an imported tracker item came from.
 * Carries everything the source chip needs to render (and re-snapshot) even
 * when the importing extension is uninstalled or offline.
 */
export interface ExternalSourceRef {
  /** Importer contribution id, e.g. 'github-issues', 'linear'. */
  providerId: string;
  /** Opaque per-provider identifier (issue number, GID, URL fragment, etc.). */
  externalId: string;
  /** Stable URN, namespaced by scheme: 'github://owner/repo#42', 'linear://NIM-123'. */
  urn: string;
  /** Canonical URL to open in a browser. */
  url: string;
  /** Snapshot of the upstream title at last import (display fallback when provider is offline). */
  titleSnapshot: string;
  /** Snapshot of the upstream state at last import (e.g. 'open', 'closed'). */
  stateSnapshot?: string;
  /** ISO timestamp of the first import. */
  importedAt: string;
  /** ISO timestamp of the most recent refresh. */
  lastSyncedAt: string;
  /**
   * Host-computed hash of the upstream body markdown at last sync. Lets
   * re-snapshot detect an upstream body change without storing the full body or
   * diffing Lexical content. Set by the host on import / re-snapshot.
   */
  bodyHash?: string;
  /**
   * Set by re-snapshot when the upstream body changed since last sync. The
   * detail view surfaces a banner so the user can apply or dismiss the change
   * (the body is never auto-overwritten).
   */
  upstreamBodyChanged?: boolean;
}

/**
 * How a local tracker item entered Nimbalyst. Replaces the loose
 * `source`/`sourceRef` pair (kept deprecated for one release for back-compat).
 * Absent on legacy items — default to `{ kind: 'native' }` at read time via
 * {@link normalizeTrackerOrigin}.
 */
export type TrackerOrigin =
  | { kind: 'native' }
  | { kind: 'inline'; filePath: string }
  | { kind: 'frontmatter'; filePath: string }
  | { kind: 'external'; external: ExternalSourceRef };

/**
 * Identity record for tracker item authorship and attribution.
 * Email is the canonical key for matching users across orgs and login states.
 * Display info is snapshotted at write time for offline rendering.
 */
export interface TrackerIdentity {
  /** Email -- stable cross-org identifier, canonical key for "is this the same person?" */
  email: string | null;
  /** Display name snapshotted at write time */
  displayName: string;
  /** Git user.name (fallback matching when no email) */
  gitName: string | null;
  /** Git user.email (fallback matching when no email) */
  gitEmail: string | null;
}

/**
 * Activity log entry for tracker item mutations.
 * Stored as a JSONB array on the tracker item's data.activity field.
 */
export interface TrackerActivity {
  id: string;
  authorIdentity: TrackerIdentity;
  action: 'created' | 'updated' | 'commented' | 'status_changed' | 'assigned' | 'archived';
  /** Which field changed (for 'updated' actions) */
  field?: string;
  /** Previous value */
  oldValue?: string;
  /** New value */
  newValue?: string;
  /** Epoch ms */
  timestamp: number;
}

/**
 * Tracker item entry in the database cache
 */
export interface TrackerItem {
  id: string;
  /** Human-readable sequential number assigned by the shared tracker room. */
  issueNumber?: number;
  /** Human-readable key like NIM-123 assigned by the shared tracker room. */
  issueKey?: string;
  type: TrackerItemType;
  /** All type tags including primary type. Enables multi-type items. */
  typeTags?: string[];
  title: string;
  description?: string;   // Optional description from indented content
  status: TrackerItemStatus;
  priority?: TrackerItemPriority;
  owner?: string;
  module: string;         // file path where item is defined
  lineNumber?: number;
  workspace: string;
  tags?: string[];
  created?: string;
  updated?: string;
  dueDate?: string;
  progress?: number;      // Progress percentage (0-100) for items that support it
  lastIndexed: Date;
  /** Extra fields from frontmatter defined by the tracker model */
  customFields?: Record<string, any>;

  // Rich content (Lexical editor state stored in PGLite)
  /** Lexical editor state JSON for rich body content */
  content?: any;
  /** Whether the item is archived */
  archived?: boolean;
  /** When the item was archived */
  archivedAt?: string;
  /**
   * Structured origin record: how the item entered Nimbalyst and, for imports,
   * a pointer back to the upstream source. Absent on legacy items — default to
   * `{ kind: 'native' }` at read time via {@link normalizeTrackerOrigin}.
   */
  origin?: TrackerOrigin;
  /** @deprecated Use {@link origin}. How the item was created. */
  source?: TrackerItemSource;
  /** @deprecated Use {@link origin}. Origin reference: file path for inline/frontmatter, 'linear:NIM-123' for imports. */
  sourceRef?: string;

  // Identity fields
  /** Structured author identity (who created this item) */
  authorIdentity?: TrackerIdentity | null;
  /** Structured last-modifier identity */
  lastModifiedBy?: TrackerIdentity | null;
  /** Whether this item was created by an AI agent on behalf of the user */
  createdByAgent?: boolean;

  // Collaborative fields (populated when item is synced via TrackerRoom)
  /** Assignee email (stable cross-org identifier) */
  assigneeEmail?: string;
  /** Reporter email (stable cross-org identifier) */
  reporterEmail?: string;
  /** @deprecated Use assigneeEmail instead. Org member ID, per-team scoped. */
  assigneeId?: string;
  /** @deprecated Use reporterEmail instead. Org member ID, per-team scoped. */
  reporterId?: string;
  /** Labels for categorization (projection of non-tombstoned entries in `labelsMap`). */
  labels?: string[];
  /**
   * Add-wins CRDT map for labels. Each `LabelEntry` has a stable per-element
   * ID; concurrent additions across peers all survive after union. Tombstoned
   * entries are excluded from the `labels` projection. Optional because
   * legacy items written before the CRDT shipped have only `labels`.
   * See `trackerLabels.ts` for the merge / diff helpers.
   */
  labelsMap?: Record<string, { value: string; id: string; tombstone?: true }>;
  /** Linked AI session IDs */
  linkedSessions?: string[];
  /** Linked git commit SHA (deprecated: use linkedCommits) */
  linkedCommitSha?: string;
  /** Linked git commits with metadata */
  linkedCommits?: Array<{ sha: string; message: string; sessionId?: string; timestamp: string }>;
  /** DocumentRoom ID for rich collaborative content */
  documentId?: string;
  /** Sync status: local (never synced), synced (up to date), pending (queued for sync) */
  syncStatus?: TrackerItemSyncStatus;

  /**
   * Body Y.Doc version pointer. Bumped on every body save (phase 4b of
   * the tracker sync redesign, see D5). Carried through the sync wire
   * envelope so remote clients can invalidate stale cached body
   * snapshots without re-reading the Y.Doc. Zero for items whose body
   * has never been written.
   */
  bodyVersion?: number;
}

/**
 * Event emitted when tracker items change
 */
export interface TrackerItemChangeEvent {
  added: TrackerItem[];
  updated: TrackerItem[];
  removed: string[];    // Just IDs for removed entries
  timestamp: Date;
}

export interface DocumentService {
  /**
   * List all documents in the current workspace
   */
  listDocuments(): Promise<Document[]>;

  /**
   * Search documents by query string
   */
  searchDocuments(query: string): Promise<Document[]>;

  /**
   * Get a specific document by ID
   */
  getDocument(id: string): Promise<Document | null>;

  /**
   * Get a document by path
   */
  getDocumentByPath(path: string): Promise<Document | null>;

  /**
   * Watch for document changes
   */
  watchDocuments(callback: (documents: Document[]) => void): () => void;

  /**
   * Open a document (platform-specific implementation)
   */
  openDocument(documentId: string, fallback?: DocumentOpenOptions): Promise<void>;

  /**
   * Get metadata for a specific document by ID
   */
  getDocumentMetadata?(id: string): Promise<DocumentMetadataEntry | null>;

  /**
   * Get metadata for a specific document by path
   */
  getDocumentMetadataByPath?(path: string): Promise<DocumentMetadataEntry | null>;

  /**
   * List metadata for all documents
   */
  listDocumentMetadata?(): Promise<DocumentMetadataEntry[]>;

  /**
   * Watch for metadata changes
   */
  watchDocumentMetadata?(
    listener: (change: MetadataChangeEvent) => void
  ): () => void;

  /**
   * Notify that a document's frontmatter has changed (e.g., from AI summary generation)
   */
  notifyFrontmatterChanged?(path: string, frontmatter: Record<string, unknown>): void;

  /**
   * List all tracker items in the workspace
   */
  listTrackerItems?(): Promise<TrackerItem[]>;

  /**
   * Get tracker items by type
   */
  getTrackerItemsByType?(type: TrackerItemType): Promise<TrackerItem[]>;

  /**
   * Get tracker items by module (file path)
   */
  getTrackerItemsByModule?(module: string): Promise<TrackerItem[]>;

  /**
   * Watch for tracker item changes
   */
  watchTrackerItems?(
    listener: (change: TrackerItemChangeEvent) => void
  ): () => void;
}

/**
 * Factory interface for creating platform-specific document service instances
 */
export interface DocumentServiceFactory {
  createDocumentService(): DocumentService;
}
