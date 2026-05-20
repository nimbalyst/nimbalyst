/**
 * Tracker Data Host Adapter (Electron)
 *
 * Centralized IPC listener that populates the cross-platform tracker data atoms
 * defined in @nimbalyst/runtime. This is the Electron-specific adapter that bridges
 * IPC events to reactive Jotai atoms.
 *
 * Follows IPC_LISTENERS.md:
 * - Components NEVER subscribe to IPC events directly
 * - This listener subscribes ONCE at startup
 * - Updates atoms; components read from atoms
 *
 * Data flow:
 *   Main process (PGLite / TrackerSyncManager)
 *     -> IPC events (document-service:tracker-items-changed, tracker-sync:*)
 *     -> This listener
 *     -> store.set(trackerDataAtoms)
 *     -> TrackerTable reads via useAtomValue
 *
 * Call initTrackerSyncListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  replaceAllTrackerItemsAtom,
  upsertTrackerItemAtom,
  removeTrackerItemAtom,
  trackerDataLoadedAtom,
} from '@nimbalyst/runtime';
import type { TrackerItem, TrackerItemChangeEvent, TrackerItemType } from '@nimbalyst/runtime';
import {
  globalRegistry,
  convertFullDocumentToTrackerItems,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { trackerItemToRecord, type TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { trackerSyncConfigChangeAtom, trackerSyncRejectionAtom, type TrackerSyncRejectionCode } from '../atoms/trackerSync';

/** Auto-clear delay for transient rotation locks. Matches the typical
 *  team rotation window -- by 30s the org-wide write freeze should have
 *  lifted, so the user can stop seeing the banner without manual action. */
const ROTATION_LOCKED_TTL_MS = 30_000;

/**
 * Load full-document tracker items from frontmatter metadata.
 * These are items like plans, decisions, blog posts where the entire
 * document IS the tracker item (identified by frontmatter, not inline syntax).
 */
async function loadFrontmatterTrackerItems(): Promise<TrackerRecord[]> {
  try {
    const metadata = await window.electronAPI.invoke('document-service:metadata-list');
    if (!metadata?.length) return [];

    const trackerTypes = globalRegistry.getAll();
    const fullDocumentTrackers = trackerTypes.filter(t => t.modes.fullDocument);

    let records: TrackerRecord[] = [];
    for (const tracker of fullDocumentTrackers) {
      const converted = convertFullDocumentToTrackerItems(metadata, tracker.type as TrackerItemType);
      records = [...records, ...converted];
    }

    // Ensure each frontmatter record has a stable ID (keyed by doc path + type)
    return records.map(record => ({
      ...record,
      id: record.id || `fm:${record.primaryType}:${record.system.documentPath}`,
    }));
  } catch (err) {
    console.error('[trackerSyncListeners] Failed to load frontmatter items:', err);
    return [];
  }
}

/**
 * Fetch all tracker items from PGLite via IPC and frontmatter metadata,
 * then merge and load into atoms.
 */
async function loadAllTrackerItems(): Promise<void> {
  try {
    const [pgliteItems, frontmatterRecords] = await Promise.all([
      window.electronAPI.invoke('document-service:tracker-items-list') as Promise<TrackerItem[]>,
      loadFrontmatterTrackerItems(),
    ]);

    // Convert PGLite items (legacy TrackerItem shape) to TrackerRecord
    const pgliteRecords = (pgliteItems || []).map(trackerItemToRecord);
    // Merge: frontmatter records first, then PGLite records overwrite by ID.
    // replaceAllTrackerItemsAtom uses Map.set() so last-write-wins -- PGLite
    // records are richer (have sync status, issue keys, etc.) and take priority.
    const allRecords = [...frontmatterRecords, ...pgliteRecords];
    store.set(replaceAllTrackerItemsAtom, allRecords);
  } catch (err) {
    console.error('[trackerSyncListeners] Failed to load tracker items:', err);
    // Mark as loaded even on error so UI doesn't stay in loading state
    store.set(trackerDataLoadedAtom, true);
  }
}

/**
 * Trigger a workspace scan to populate tracker items in PGLite.
 * The DocumentService constructor skips the initial scan for performance,
 * so tracker items won't exist in PGLite until something triggers a scan.
 * We do this after the initial load so the UI shows cached data immediately,
 * then updates reactively via tracker-items-changed events as the scan indexes files.
 */
async function triggerWorkspaceScan(): Promise<void> {
  try {
    await window.electronAPI.invoke('document-service:refresh-workspace');
  } catch (err) {
    console.error('[trackerSyncListeners] Workspace scan failed:', err);
  }
}

/**
 * Initialize tracker data listeners.
 * Performs initial data load and subscribes to change events.
 *
 * @returns Cleanup function to remove listeners
 */
export function initTrackerSyncListeners(): () => void {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let initialScanTimer: ReturnType<typeof setTimeout> | null = null;
  let rotationLockedClearTimer: ReturnType<typeof setTimeout> | null = null;

  // `tracker-sync:mutation-rejected` is broadcast when the server rejects
  // a write. `staleKeyEpoch + refreshKey succeeds` is silently retried by
  // the engine; the only events that reach the renderer are the unrecovered
  // ones the user needs to see. `forbidden` and `malformed` are bugs
  // (not user-facing) and stay off the banner -- log them and let the
  // optimistic-rollback surface the failure indirectly.
  cleanups.push(
    window.electronAPI.on(
      'tracker-sync:mutation-rejected',
      (data: {
        workspacePath: string;
        itemId: string;
        clientMutationId?: string;
        code: TrackerSyncRejectionCode | 'forbidden' | 'malformed';
        message?: string;
      }) => {
        if (!data) return;
        if (data.code !== 'staleKeyEpoch' && data.code !== 'rotationLocked') {
          console.error('[trackerSyncListeners] tracker-sync rejection (non-banner)', data);
          return;
        }
        const rejection = {
          workspacePath: data.workspacePath,
          code: data.code,
          itemId: data.itemId,
          message: data.message,
          timestamp: Date.now(),
        };
        store.set(trackerSyncRejectionAtom, (prev) => ({
          ...prev,
          [data.code as TrackerSyncRejectionCode]: rejection,
        }));
        if (data.code === 'rotationLocked') {
          // Each fresh rotationLocked event resets the TTL -- writes
          // during an extended freeze should not surprise the user with
          // an empty banner mid-rotation.
          if (rotationLockedClearTimer) clearTimeout(rotationLockedClearTimer);
          rotationLockedClearTimer = setTimeout(() => {
            rotationLockedClearTimer = null;
            store.set(trackerSyncRejectionAtom, (prev) => ({ ...prev, rotationLocked: null }));
          }, ROTATION_LOCKED_TTL_MS);
        }
      },
    ),
  );

  // `tracker-sync:config-changed` is broadcast by the main process whenever a
  // tracker-sync subscription updates its config (e.g. issueKeyPrefix) -- can
  // happen on any workspace. Bumped into a request atom so the Settings >
  // Tracker Config panel can mirror the change without subscribing to IPC
  // itself. Registered outside the workspace-mode block below because this
  // event is workspace-tagged in the payload.
  let configChangeVersion = 0;
  cleanups.push(
    window.electronAPI.on(
      'tracker-sync:config-changed',
      (data: { workspacePath: string; config: { issueKeyPrefix: string } }) => {
        if (!data?.workspacePath || !data.config) return;
        configChangeVersion += 1;
        store.set(trackerSyncConfigChangeAtom, {
          version: configChangeVersion,
          payload: data,
        });
      },
    ),
  );

  // console.log('[trackerSyncListeners] Initializing tracker data listeners');

  // Track this window's workspace so we can defensively filter cross-project
  // tracker events. The main-process broadcast is already scoped to the right
  // window, but a stray event from a buggy code path would still leak a
  // foreign item into our atoms and display it until the next refresh.
  let currentWorkspacePath: string | null = null;
  void window.electronAPI
    .invoke('get-initial-state')
    .then(async (state: { mode?: string; workspacePath?: string } | null) => {
      if (disposed) return;

      // Only workspace windows have a main-process document service.
      // Workspace manager / utility windows share the same renderer shell,
      // so they must skip these IPC calls entirely.
      if (state?.mode !== 'workspace' || !state.workspacePath) {
        return;
      }

      currentWorkspacePath = state.workspacePath;

      // Initial load from PGLite + frontmatter (shows cached data from previous session)
      await loadAllTrackerItems();
      if (disposed) return;

      // Trigger a workspace scan to index new/changed files into PGLite.
      // The DocumentService skips scanning on startup for performance,
      // so without this, tracker items won't appear until an @ mention or file open.
      // Delay slightly to avoid blocking app startup.
      initialScanTimer = setTimeout(() => {
        void triggerWorkspaceScan();
      }, 3000);

      // Subscribe to tracker item changes from ElectronDocumentService (local indexer changes)
      // This is the subscription-based IPC: we send a 'watch' message, then receive events.
      window.electronAPI.send('document-service:tracker-items-watch');

      // Handle change events with granular atom updates
      cleanups.push(
        window.electronAPI.on(
          'document-service:tracker-items-changed',
          (change: TrackerItemChangeEvent) => {
            // console.log('[trackerSyncListeners] Received tracker-items-changed:', {
            //   added: change.added?.length || 0,
            //   updated: change.updated?.length || 0,
            //   removed: change.removed?.length || 0,
            // });
            // Defensive workspace filter: drop items that belong to a different
            // workspace. If we don't know our own workspace yet (init race), pass
            // through -- the main process already filters. Items without a
            // `workspace` field (legacy / frontmatter) also pass through.
            const belongsToThisWorkspace = (item: TrackerItem): boolean => {
              if (!currentWorkspacePath) return true;
              if (!item.workspace) return true;
              return item.workspace === currentWorkspacePath;
            };

            // Apply granular updates to the atom map (convert to TrackerRecord)
            if (change.added?.length) {
              for (const item of change.added) {
                if (!belongsToThisWorkspace(item)) continue;
                store.set(upsertTrackerItemAtom, trackerItemToRecord(item));
              }
            }
            if (change.updated?.length) {
              for (const item of change.updated) {
                if (!belongsToThisWorkspace(item)) continue;
                store.set(upsertTrackerItemAtom, trackerItemToRecord(item));
              }
            }
            if (change.removed?.length) {
              for (const id of change.removed) {
                store.set(removeTrackerItemAtom, id);
              }
            }
          }
        )
      );

      // Also subscribe to metadata changes (for full-document trackers like plans/decisions)
      window.electronAPI.send('document-service:metadata-watch');

      cleanups.push(
        window.electronAPI.on('document-service:metadata-changed', () => {
          // Full-document tracker items come from frontmatter metadata.
          // Re-fetch all items (PGLite + frontmatter) when metadata changes.
          void loadAllTrackerItems();
        })
      );
    })
    .catch(() => {
      currentWorkspacePath = null;
    });

  return () => {
    disposed = true;
    if (initialScanTimer) {
      clearTimeout(initialScanTimer);
    }
    if (rotationLockedClearTimer) {
      clearTimeout(rotationLockedClearTimer);
    }
    cleanups.forEach((cleanup) => cleanup());
  };
}
