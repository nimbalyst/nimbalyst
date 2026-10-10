/**
 * Persistence for the list of collaborative documents that are open as tabs
 * in a workspace. Survives full app restart so we can restore the user's
 * working set.
 *
 * The entry payload carries `documentType` alongside the document id. Without
 * it, the restore path falls back to `markdown` in `CollaborativeTabEditor`
 * and a shared `.excalidraw` / `.mockup.html` gets routed to the Markdown
 * editor over a non-markdown Y.Doc -- which renders blank, even though the
 * content is synced.
 *
 * Legacy shape: workspace-state previously stored only
 * `openCollabDocumentIds: string[]`. We migrate those on read by tagging
 * them as `markdown` (the only collab type that existed when that shape
 * shipped). Both keys are written for one release cycle so a downgrade
 * doesn't lose the tabs.
 */
import type { CollabScope } from '@nimbalyst/collab-client/core';

export interface PersistedCollabEntry {
  documentId: string;
  documentType: string;
  /** Tab-strip presentation state; entry order is the persisted tab order. */
  isPinned?: boolean;
  /** Last-known server-backed logical path. Warm fallback until index sync. */
  displayPath?: string;
  metadataVersion?: 2;
  fileExtension?: string;
  editorId?: string;
}

/**
 * A tracker item page (`tracker://<id>`), a type page (`type://<id>`), a
 * database personal page (`personal://<documentId>`) or a Local wiki page's
 * markdown file (`file`, by absolute path) open in Pages mode. It shares
 * the doc entries array so tab order survives across kinds, and deliberately
 * carries no `documentId` / `documentType`: every doc-only reader (older
 * builds, the main-process type resolver) filters on those two strings and so
 * skips a page entry instead of opening it as a doc.
 */
export interface PersistedCollabPageEntry {
  kind: PersistedCollabPageKind;
  /**
   * Tracker item id for `tracker`, type id for `type`, document id for
   * `personal`, the absolute path for `file`, and the section (`team` /
   * `personal`) for `search` and `types`.
   */
  artifactId: string;
  /** Last-known tab title, shown until the live title resolves. */
  title?: string;
  isPinned?: boolean;
}

export type PersistedCollabPageKind = 'tracker' | 'type' | 'personal' | 'file' | 'search' | 'types';

function isPageKind(kind: unknown): kind is PersistedCollabPageKind {
  return kind === 'tracker' || kind === 'type' || kind === 'personal' || kind === 'file' || kind === 'search' || kind === 'types';
}

export type PersistedCollabTabEntry = PersistedCollabEntry | PersistedCollabPageEntry;

export function isPersistedCollabPageEntry(
  entry: PersistedCollabTabEntry,
): entry is PersistedCollabPageEntry {
  return 'kind' in entry && isPageKind(entry.kind);
}

interface WorkspaceState {
  openCollabDocumentIds?: string[];
  openCollabDocumentEntries?: PersistedCollabTabEntry[];
  [key: string]: unknown;
}

/** Save the open tab list (docs and pages, in tab order) to workspace state. */
export async function persistOpenCollabDocs(
  scope: CollabScope,
  entries: PersistedCollabTabEntry[],
): Promise<void> {
  try {
    await window.electronAPI?.invoke?.('workspace:update-state', scope.scopeKey, {
      openCollabDocumentEntries: entries,
      // Keep the legacy key in sync for one release so downgrades still find
      // the tabs (they'll come back as markdown -- better than disappearing).
      openCollabDocumentIds: entries
        .filter((e): e is PersistedCollabEntry => !isPersistedCollabPageEntry(e))
        .map((e) => e.documentId),
    });
  } catch (err) {
    console.warn('[collabOpenDocsPersistence] Failed to persist open collab docs:', err);
  }
}

/**
 * Load the open-doc list. Reads the new `openCollabDocumentEntries` shape if
 * present; otherwise migrates legacy `openCollabDocumentIds: string[]` by
 * tagging each id as `markdown`.
 */
export async function loadOpenCollabDocs(
  scope: CollabScope,
): Promise<PersistedCollabEntry[]> {
  return (await loadOpenCollabTabs(scope))
    .filter((entry): entry is PersistedCollabEntry => !isPersistedCollabPageEntry(entry));
}

/** Load every persisted Pages-mode tab (docs, item pages, type pages) in tab order. */
export async function loadOpenCollabTabs(
  scope: CollabScope,
): Promise<PersistedCollabTabEntry[]> {
  try {
    const state = (await window.electronAPI?.invoke?.(
      'workspace:get-state',
      scope.scopeKey,
    )) as WorkspaceState | undefined;
    return readTabEntriesFromState(state);
  } catch {
    return [];
  }
}

/**
 * Look up the persisted documentType for a single open doc. Used by
 * `TabContent.loadContent` when restoring a collab tab whose in-memory
 * config registry was cleared (fresh renderer, HMR, restart).
 */
export async function getPersistedCollabDocType(
  scope: CollabScope,
  documentId: string,
): Promise<string | undefined> {
  const entries = await loadOpenCollabDocs(scope);
  return entries.find((e) => e.documentId === documentId)?.documentType;
}

/** Full persisted type identity used when rebuilding a cold opener config. */
export async function getPersistedCollabDocMetadata(
  scope: CollabScope,
  documentId: string,
): Promise<PersistedCollabEntry | undefined> {
  const entries = await loadOpenCollabDocs(scope);
  return entries.find((entry) => entry.documentId === documentId);
}

/** Internal: parse the workspace-state blob into entries. Exported for tests. */
export function readEntriesFromState(
  state: WorkspaceState | undefined,
): PersistedCollabEntry[] {
  return readTabEntriesFromState(state)
    .filter((entry): entry is PersistedCollabEntry => !isPersistedCollabPageEntry(entry));
}

function readPageEntry(raw: unknown): PersistedCollabPageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<PersistedCollabPageEntry>;
  if (!isPageKind(entry.kind)) return null;
  if (typeof entry.artifactId !== 'string' || !entry.artifactId.trim()) return null;
  return {
    kind: entry.kind,
    artifactId: entry.artifactId,
    ...(typeof entry.title === 'string' && entry.title.trim() ? { title: entry.title } : {}),
    ...(typeof entry.isPinned === 'boolean' ? { isPinned: entry.isPinned } : {}),
  };
}

/** Internal: parse doc and page entries in persisted order. Exported for tests. */
export function readTabEntriesFromState(
  state: WorkspaceState | undefined,
): PersistedCollabTabEntry[] {
  if (!state) return [];

  if (Array.isArray(state.openCollabDocumentEntries)) {
    return state.openCollabDocumentEntries.flatMap<PersistedCollabTabEntry>((raw) => {
      if (raw && typeof raw === 'object' && 'kind' in raw) {
        const page = readPageEntry(raw);
        return page ? [page] : [];
      }
      const entry = raw as PersistedCollabEntry | undefined;
      if (!entry || typeof entry.documentId !== 'string' || typeof entry.documentType !== 'string') {
        return [];
      }
      return [{
        documentId: entry.documentId,
        documentType: entry.documentType,
        ...(typeof entry.isPinned === 'boolean' ? { isPinned: entry.isPinned } : {}),
        ...(entry.metadataVersion === 2 ? { metadataVersion: 2 as const } : {}),
        ...(typeof entry.fileExtension === 'string' && entry.fileExtension.trim()
          ? { fileExtension: entry.fileExtension }
          : {}),
        ...(typeof entry.editorId === 'string' && entry.editorId.trim()
          ? { editorId: entry.editorId }
          : {}),
        ...(typeof entry.displayPath === 'string' && entry.displayPath.trim()
          ? { displayPath: entry.displayPath }
          : {}),
      }];
    });
  }

  if (Array.isArray(state.openCollabDocumentIds)) {
    return state.openCollabDocumentIds
      .filter((id): id is string => typeof id === 'string')
      .map((documentId) => ({ documentId, documentType: 'markdown' }));
  }

  return [];
}
