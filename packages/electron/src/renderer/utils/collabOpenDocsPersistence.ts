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
export interface PersistedCollabEntry {
  documentId: string;
  documentType: string;
}

interface WorkspaceState {
  openCollabDocumentIds?: string[];
  openCollabDocumentEntries?: PersistedCollabEntry[];
  [key: string]: unknown;
}

/** Save the open-doc list to workspace state. */
export async function persistOpenCollabDocs(
  workspacePath: string,
  entries: PersistedCollabEntry[],
): Promise<void> {
  try {
    await window.electronAPI?.invoke?.('workspace:update-state', workspacePath, {
      openCollabDocumentEntries: entries,
      // Keep the legacy key in sync for one release so downgrades still find
      // the tabs (they'll come back as markdown -- better than disappearing).
      openCollabDocumentIds: entries.map((e) => e.documentId),
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
  workspacePath: string,
): Promise<PersistedCollabEntry[]> {
  try {
    const state = (await window.electronAPI?.invoke?.(
      'workspace:get-state',
      workspacePath,
    )) as WorkspaceState | undefined;
    return readEntriesFromState(state);
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
  workspacePath: string,
  documentId: string,
): Promise<string | undefined> {
  const entries = await loadOpenCollabDocs(workspacePath);
  return entries.find((e) => e.documentId === documentId)?.documentType;
}

/** Internal: parse the workspace-state blob into entries. Exported for tests. */
export function readEntriesFromState(
  state: WorkspaceState | undefined,
): PersistedCollabEntry[] {
  if (!state) return [];

  if (Array.isArray(state.openCollabDocumentEntries)) {
    return state.openCollabDocumentEntries.filter(
      (e): e is PersistedCollabEntry =>
        !!e &&
        typeof e.documentId === 'string' &&
        typeof e.documentType === 'string',
    );
  }

  if (Array.isArray(state.openCollabDocumentIds)) {
    return state.openCollabDocumentIds
      .filter((id): id is string => typeof id === 'string')
      .map((documentId) => ({ documentId, documentType: 'markdown' }));
  }

  return [];
}
