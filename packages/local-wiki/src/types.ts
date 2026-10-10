/**
 * Public types. The document, placement and snapshot shapes mirror
 * `CollabDocsDataSource` (`@nimbalyst/collab-client/docs/dataSource.ts`)
 * structurally, so a host adapter can hand them to the page-tree UI without
 * reshaping. They are restated here because this package must not depend on
 * the collab client.
 */

export type ParentKind = 'page' | 'item';

export type WikiIssueCode =
  | 'malformed-frontmatter'
  | 'malformed-table'
  | 'malformed-type'
  | 'duplicate-id'
  | 'duplicate-table'
  | 'case-clash'
  | 'broken-link'
  | 'malformed-sidecar'
  | 'orphan-sidecar'
  | 'unsafe-id'
  | 'repair-failed';

/** Something the scan found and did not (or could not) fix. Never thrown. */
export interface WikiIssue {
  code: WikiIssueCode;
  /** Wiki-relative path, or an absolute path for a type file. */
  path: string;
  message: string;
  id?: string;
}

/** Every page in the wiki, plain or typed, live or in trash. */
export interface LocalPage {
  id: string;
  title: string;
  /** Tracker type for a typed page; null for a plain page. */
  type: string | null;
  /** Frontmatter keys other than `id`, `title`, `type`, `order`. */
  fields: Record<string, unknown>;
  parentId: string | null;
  parentKind: ParentKind | null;
  /** The `order` frontmatter value; null when unset. */
  order: number | null;
  /** `markdown`, or an editor page's document type (`excalidraw`, `csv`, ...). */
  documentType: string;
  /** `.md`, or an editor page's file suffix (`.excalidraw`, `.mockup.html`). */
  fileExtension: string;
  /** Wiki-relative path of the page file (markdown or editor file); null for a bare folder. */
  path: string | null;
  /** Wiki-relative path of the page's child folder (it may not exist). */
  dir: string;
  /** Where the body comes from: `Name.md`, `Name/README.md` (or index.md), or nowhere. */
  bodySource: 'file' | 'readme' | 'none';
  /** Body version (see `readBody`). */
  version: string;
  hasContent: boolean;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  /** Frontmatter could not be parsed, or its id is not a safe token; the file is read-only until fixed by hand. */
  malformed?: boolean;
}

/** Structural twin of `SharedDocument` for a plain page. */
export interface LocalDocument {
  documentId: string;
  teamProjectId: null;
  title: string;
  documentType: string;
  metadataVersion: 2;
  fileExtension: string;
  editorId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  parentFolderId: string | null;
  parentKind?: ParentKind;
  sortOrder: number | null;
  trashedAt: number | null;
  hasContent: boolean;
  fields?: Record<string, unknown>;
}

/** Structural twin of `SharedTypePlacement`: where a table type's CSV sits. */
export interface LocalTypePlacement {
  typeId: string;
  projectId: null;
  parentFolderId: string | null;
  parentKind?: ParentKind;
  sortOrder: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Structural twin of `SharedItemPlacement`: where a typed page sits. */
export interface LocalItemPlacement {
  itemId: string;
  projectId: null;
  parentId: string | null;
  parentKind?: ParentKind;
  sortOrder: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface LocalTableInfo {
  typeId: string;
  /** Wiki-relative path of the CSV. */
  path: string;
  parentId: string | null;
  parentKind: ParentKind | null;
  rowCount: number;
  version: string;
  malformed?: boolean;
}

/**
 * The tree. `items`, `containers`, `typePlacements`, `itemPlacements`,
 * `pageTree`, `pageFields` and `primaryProjectId` follow `CollabDocsSnapshot`;
 * the rest is for callers that want the whole model (`nim`, the HTTP server).
 */
export interface LocalWikiSnapshot {
  items: LocalDocument[];
  containers: [];
  typePlacements: LocalTypePlacement[];
  itemPlacements: LocalItemPlacement[];
  pageTree: true;
  pageFields: true;
  primaryProjectId: null;
  formatVersion: number;
  pages: LocalPage[];
  tables: LocalTableInfo[];
  issues: WikiIssue[];
}

/** Page-tree commands, named after `CollabDocsCommand`. */
export type LocalWikiCommand =
  | {
      type: 'register-document';
      /** Omit to get a new ULID. */
      documentId?: string;
      title: string;
      parentFolderId: string | null;
      parentKind?: ParentKind;
      sortOrder?: number | null;
      /** Tracker type for a typed page. Markdown pages only. */
      pageType?: string | null;
      fields?: Record<string, unknown>;
      /** Markdown body, or an editor page's raw file text. */
      body?: string;
      /** Default `markdown`; any other type makes an editor page (see FORMAT.md). */
      documentType?: string;
      /** Editor page file suffix, e.g. `.excalidraw`. Default: the first suffix the editor types map to `documentType`. */
      fileExtension?: string;
    }
  | { type: 'update-document-title'; documentId: string; title: string }
  | { type: 'set-document-fields'; documentId: string; fields: Record<string, unknown> }
  | { type: 'set-document-type'; documentId: string; pageType: string | null }
  | { type: 'remove-document'; documentId: string; purge?: true }
  | { type: 'trash-document'; documentId: string; trashedAt?: number }
  | { type: 'restore-document'; documentId: string }
  | {
      type: 'move-document';
      documentId: string;
      parentFolderId: string | null;
      parentKind?: ParentKind;
      sortOrder?: number | null;
    }
  | { type: 'set-item-placement'; itemId: string; parentId: string | null; sortOrder: number; parentKind?: ParentKind }
  | { type: 'set-type-placement'; typeId: string; parentFolderId: string | null; sortOrder: number; parentKind?: ParentKind }
  | { type: 'refresh' };

export interface LocalWikiCommandResult {
  ok: true;
  /** The page or row the command created or changed. */
  id?: string;
  /** New body version, when the command wrote a body. */
  version?: string;
  /** `remove-document` with `purge`: entries deleted from trash. */
  purged?: number;
}

export type WriteBodyResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'conflict'; currentVersion: string; markdown: string };

export interface ReadBodyResult {
  /** Markdown body without frontmatter, or an editor page's raw file text. */
  markdown: string;
  version: string;
  /** For a malformed file, the whole raw file text. */
  malformed?: boolean;
}

/** A typed item, page-backed or a CSV row. Field values are as stored: relationship fields hold ids. */
export interface LocalTrackerItem {
  id: string;
  type: string;
  title: string;
  fields: Record<string, unknown>;
  storage: 'pages' | 'table';
  /** Markdown file (pages) or CSV (table), wiki-relative. */
  path: string | null;
  parentId: string | null;
  parentKind: ParentKind | null;
  order: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LocalTrackerSnapshot {
  typeId: string;
  storage: 'pages' | 'table';
  items: LocalTrackerItem[];
  /** Table types: the CSV content version; pages: null. */
  version: string | null;
}

/** Tracker commands, named after `TrackerDataCommand`. */
export type LocalTrackerCommand =
  | {
      type: 'create-item';
      item: {
        id?: string;
        title: string;
        fields?: Record<string, unknown>;
        /** Page types only: where the new page goes. Default root. */
        parentId?: string | null;
        parentKind?: ParentKind;
        body?: string;
      };
    }
  | { type: 'update-item'; input: { itemId: string; updates: Record<string, unknown> } }
  | { type: 'delete-item'; itemId: string };

export interface LocalSearchHit {
  id: string;
  title: string;
  kind: 'page' | 'row';
  type: string | null;
  path: string | null;
  snippet: string;
  score: number;
}

export interface LocalWikiChange {
  /** Pages or rows added or changed since the last notification. */
  changedIds: string[];
  removedIds: string[];
  /** Table types whose CSV changed. */
  tableTypes: string[];
}

export interface ActivityEntry {
  at: string;
  itemId: string;
  action: 'create' | 'update' | 'trash' | 'restore';
  actor?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
}

/** fs.watch stand-in so tests and hosts can drive change detection. */
export type WatchFactory = (dir: string, onEvent: () => void) => { close(): void };

export interface OpenWikiOptions {
  /** `.nimbalyst/trackers` of the project. Without it no table types exist. */
  typesDir?: string | null;
  /**
   * Fix what the scan can fix: add missing ids, replace duplicate ids, repoint
   * stale links. Default true; false opens the folder without writing.
   */
  repair?: boolean;
  /** Recorded in activity entries. */
  actor?: string;
  watchFactory?: WatchFactory;
  /**
   * File suffix to document type for editor pages, e.g. `{ '.excalidraw':
   * 'excalidraw' }`. Default `DEFAULT_EDITOR_TYPES`. Markdown and code do not
   * belong here. A file with a sidecar is a page whatever this says.
   */
  editorTypes?: Readonly<Record<string, string>>;
  debounceMs?: number;
  now?: () => number;
  /** How long a write waits for another process's write lock. Default 10s. */
  lockTimeoutMs?: number;
  /** A write lock untouched for this long is abandoned and taken over. Default 30s. */
  lockStaleMs?: number;
  /**
   * How long a second file carrying an existing id is read under a
   * path-derived id before it is given a new one. Default 60s, long enough for
   * a sync rename's delete to catch up with its add.
   */
  duplicateGraceMs?: number;
}
