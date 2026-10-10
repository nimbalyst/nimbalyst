/**
 * The workspace event bus subscription for project file sync.
 *
 * The bus delivers gitignored Markdown on its own, but the default Local wiki
 * lives in gitignored `nimbalyst-local/`, and for any other gitignored file it
 * delivers add/unlink only to subscribers that opt into structural events, and
 * change only for paths in its bypass set. So this subscription opts in, and
 * keeps a bypass (owned by this subscriber) on every synced non-Markdown file:
 * the wiki's `.csv` tables and its marker. Tables only count once the marker
 * exists, so when the marker appears (created here or written from another
 * desktop) the tables already on disk are registered and offered for sync.
 */
import { isProjectSyncPath, isWikiMarkerPath, wikiTableFiles } from './projectSyncWikiRules';

export interface ProjectSyncWatchBus {
  addGitignoreBypass(workspacePath: string, absolutePath: string, owner: string): void;
  removeGitignoreBypass(workspacePath: string, absolutePath: string, owner: string): void;
}

export interface ProjectSyncWatchHandlers {
  saved(filePath: string, kind: 'change' | 'add'): void;
  deleted(filePath: string): void;
  /** Echo suppression: true for a path the sync service itself just wrote or removed. */
  isOwnWrite(filePath: string): boolean;
  /** The wiki's marker was created on this desktop; tables refused before it can now be received. */
  wikiCreated(): void;
}

export function createProjectSyncWatch(workspacePath: string, owner: string, bus: ProjectSyncWatchBus, handlers: ProjectSyncWatchHandlers) {
  const bypassed = new Set<string>();
  let disposed = false;

  /** True when the file was newly registered. */
  function track(filePath: string): boolean {
    if (disposed || filePath.endsWith('.md') || bypassed.has(filePath) || !isProjectSyncPath(filePath, workspacePath)) return false;
    bypassed.add(filePath);
    bus.addGitignoreBypass(workspacePath, filePath, owner);
    return true;
  }

  /** Resolves once the wiki's existing tables are registered; exposed for tests. */
  let tablesSettled: Promise<void> = Promise.resolve();
  function trackWikiTables(): void {
    tablesSettled = tablesSettled.then(async () => {
      const tables = await wikiTableFiles(workspacePath);
      // The watch may have been disposed while the scan ran.
      for (const table of tables) {
        if (disposed) return;
        if (track(table) && !handlers.isOwnWrite(table)) handlers.saved(table, 'add');
      }
    }).catch(() => undefined);
  }

  function untrack(filePath: string): void {
    if (bypassed.delete(filePath)) bus.removeGitignoreBypass(workspacePath, filePath, owner);
  }

  const save = (kind: 'change' | 'add') => (filePath: string) => {
    if (disposed || !isProjectSyncPath(filePath, workspacePath)) return;
    track(filePath);
    const isMarker = isWikiMarkerPath(filePath, workspacePath);
    if (isMarker) trackWikiTables();
    // A marker written from another desktop is the service's own write; it resyncs itself.
    if (handlers.isOwnWrite(filePath)) return;
    if (isMarker && kind === 'add') handlers.wikiCreated();
    handlers.saved(filePath, kind);
  };

  return {
    listener: {
      onChange: save('change'),
      onAdd: save('add'),
      onUnlink: (filePath: string) => {
        if (disposed) return;
        // A tracked table still counts once its wiki's marker is gone with it.
        if (!bypassed.has(filePath) && !isProjectSyncPath(filePath, workspacePath)) return;
        untrack(filePath);
        if (handlers.isOwnWrite(filePath)) return;
        handlers.deleted(filePath);
      },
      receiveGitignoredStructureEvents: true,
    },
    /** Registers files a sweep found, which produced no add event. */
    track,
    settled: () => tablesSettled,
    dispose(): void {
      disposed = true;
      for (const filePath of bypassed) bus.removeGitignoreBypass(workspacePath, filePath, owner);
      bypassed.clear();
    },
  };
}
