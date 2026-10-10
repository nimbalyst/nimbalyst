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
import type {
  TrackerDataChange,
  TrackerDataSource,
  TrackerItem,
} from '@nimbalyst/collab-client/trackers';
import {
  replaceAllTrackerItemsAtom,
  upsertTrackerItemAtom,
  removeTrackerItemAtom,
  trackerDataLoadedAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { trackerItemToRecord, type TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, isRelationshipField } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerSyncConfigChangeAtom, trackerSyncConnectionAtom, trackerSyncDrainHoldAtom, trackerSyncRejectionAtom, type TrackerSyncRejectionCode } from '../atoms/trackerSync';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { loadTrackerNavigationAtom } from '../atoms/trackerNavigation';
import {
  initTrackerPanelLayout,
  replaceSharedTrackerViewsAtom,
  setTrackerDataSourceAtom,
} from '../atoms/trackers';
import { getBodyDocCache } from '../../services/BodyDocCache';
import { ElectronTrackerDataSource } from '../../services/ElectronTrackerDataSource';
// A full replace comes from main's database, which never holds Local wiki items.
import { remergeLocalWikiRecords } from '../../services/localWikiTrackerRecords';

/** Auto-clear delay for transient rotation locks. Matches the typical
 *  team rotation window -- by 30s the org-wide write freeze should have
 *  lifted, so the user can stop seeing the banner without manual action. */
const ROTATION_LOCKED_TTL_MS = 30_000;

/** Trailing debounce for the relationship-field reconcile (NIM-1305). A bulk
 *  relationship import emits a burst of granular `tracker-items-changed`
 *  events; collapsing them into one authoritative reload after the burst
 *  settles avoids reloading per item. */
const RELATIONSHIP_RECONCILE_DEBOUNCE_MS = 300;

/** A relationship value serializes as a non-empty array of objects each bearing
 *  an `itemId` (or a single such object). Used as a fallback shape check when the
 *  item's tracker type is not yet registered in the renderer's `globalRegistry`. */
function looksLikeRelationshipValue(value: unknown): boolean {
  const hasItemId = (v: unknown): boolean =>
    typeof v === 'object' && v !== null && 'itemId' in (v as Record<string, unknown>);
  if (Array.isArray(value)) return value.length > 0 && value.every(hasItemId);
  return hasItemId(value);
}

/**
 * Whether an incoming tracker item belongs to a type that declares relationship
 * fields and carries a value for one of them. Granular `tracker-items-changed`
 * events don't say which field changed and the last-write-wins upsert can be
 * clobbered by an out-of-order/partial event during a burst, so any
 * relationship-bearing change triggers a debounced full reconcile from the
 * authoritative read model (NIM-1305).
 */
function itemCarriesRelationshipField(item: TrackerItem): boolean {
  const fields = globalRegistry.get(item.type)?.fields;
  if (!fields) {
    // Custom/workspace tracker types register asynchronously (loadCustomTrackers),
    // so a relationship change can arrive before the schema is known. Without this
    // fallback the reconcile would silently no-op for custom types and leave the
    // panel stale — the exact NIM-1305 symptom. Detect by value shape instead.
    const custom = item.customFields;
    if (custom) {
      for (const value of Object.values(custom)) {
        if (looksLikeRelationshipValue(value)) return true;
      }
    }
    return false;
  }
  for (const def of fields) {
    if (!isRelationshipField(def)) continue;
    const name = def.name;
    const onItem = (item as unknown as Record<string, unknown>)[name];
    const onCustom = item.customFields?.[name];
    if (onItem !== undefined || onCustom !== undefined) return true;
  }
  return false;
}

/**
 * Fetch all tracker items from the main-process tracker read model and load
 * them into atoms.
 */
async function loadAllTrackerItems(dataSource: TrackerDataSource, workspacePath: string | null): Promise<void> {
  try {
    const { items = [] } = await dataSource.command({ type: 'list-items' });
    const records = items.map(trackerItemToRecord);
    store.set(replaceAllTrackerItemsAtom, records);
    remergeLocalWikiRecords(workspacePath);
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
async function triggerWorkspaceScan(dataSource: TrackerDataSource): Promise<void> {
  try {
    await dataSource.command({ type: 'refresh-items' });
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
  let relationshipReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let trackerDataSource: TrackerDataSource | null = null;
  let unsubscribeTrackerDataSource: (() => void) | null = null;

  // Debounced safety net: after a relationship-bearing change event, reload the
  // full tracker read model so a partial/out-of-order granular upsert can't
  // leave relationship fields stale in the panel (NIM-1305).
  const scheduleRelationshipReconcile = () => {
    if (disposed) return;
    if (relationshipReconcileTimer) clearTimeout(relationshipReconcileTimer);
    relationshipReconcileTimer = setTimeout(() => {
      relationshipReconcileTimer = null;
      if (disposed) return;
      if (trackerDataSource) void loadAllTrackerItems(trackerDataSource, currentWorkspacePath);
    }, RELATIONSHIP_RECONCILE_DEBOUNCE_MS);
  };

  let configChangeVersion = 0;

  const upsertItems = (items: TrackerItem[]) => {
    let sawRelationshipChange = false;
    for (const item of items) {
      store.set(upsertTrackerItemAtom, trackerItemToRecord(item));
      if (itemCarriesRelationshipField(item)) sawRelationshipChange = true;
    }
    if (sawRelationshipChange) scheduleRelationshipReconcile();
  };

  const handleTrackerDataChange = (change: TrackerDataChange) => {
    switch (change.type) {
      case 'items-replaced':
        store.set(replaceAllTrackerItemsAtom, change.items.map(trackerItemToRecord));
        remergeLocalWikiRecords(currentWorkspacePath);
        return;
      case 'items-upserted':
        upsertItems(change.items);
        return;
      case 'items-removed':
        for (const itemId of change.itemIds) store.set(removeTrackerItemAtom, itemId);
        return;
      case 'saved-views-replaced':
        store.set(replaceSharedTrackerViewsAtom, change.savedViews);
        return;
      case 'status':
        store.set(trackerSyncConnectionAtom, change.sync);
        // Rides on the sync state rather than its own event: the socket is
        // `connected` while a drain hold is in force, so `status` alone cannot
        // carry it (NIM-2968). Null clears the banner on recovery.
        store.set(
          trackerSyncDrainHoldAtom,
          change.sync.drainHold
            ? { workspacePath: change.sync.workspacePath, ...change.sync.drainHold }
            : null,
        );
        return;
      case 'config-changed':
        configChangeVersion += 1;
        store.set(trackerSyncConfigChangeAtom, {
          version: configChangeVersion,
          payload: { workspacePath: change.workspacePath, config: change.config },
        });
        return;
      case 'mutation-rejected': {
        const data = change.rejection;
        if (
          data.code !== 'staleKeyEpoch' &&
          data.code !== 'rotationLocked' &&
          data.code !== 'custodyUnavailable'
        ) {
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
          if (rotationLockedClearTimer) clearTimeout(rotationLockedClearTimer);
          rotationLockedClearTimer = setTimeout(() => {
            rotationLockedClearTimer = null;
            store.set(trackerSyncRejectionAtom, (prev) => ({ ...prev, rotationLocked: null }));
          }, ROTATION_LOCKED_TTL_MS);
        }
      }
    }
  };

  const bindTrackerDataSource = (workspacePath: string): TrackerDataSource => {
    unsubscribeTrackerDataSource?.();
    trackerDataSource?.dispose();
    const next = new ElectronTrackerDataSource({ workspacePath });
    trackerDataSource = next;
    store.set(setTrackerDataSourceAtom, next);
    unsubscribeTrackerDataSource = next.subscribe(handleTrackerDataChange);
    return next;
  };

  // console.log('[trackerSyncListeners] Initializing tracker data listeners');

  // Track this window's workspace so we can defensively filter cross-project
  // tracker events. The main-process broadcast is already scoped to the right
  // window, but a stray event from a buggy code path would still leak a
  // foreign item into our atoms and display it until the next refresh.
  let currentWorkspacePath: string | null = null;
  // An agent body write routed in from the main process, to be applied through
  // the DocumentSyncProvider the open editor is bound to. The warm BodyDocCache
  // entry is the authority on whether this window can serve the write -- this
  // handler deliberately does NOT compare against `currentWorkspacePath`, both
  // because the item may belong to a non-active project this window has open
  // and because that comparison disagreed with main's window selection, which
  // sent writes that were then refused and demoted to the headless peer.
  //
  // `expiresAt` is main's deadline to START. Past it, main has already fallen
  // back, and applying anyway would land the body twice: two replicas each
  // running `clear + insert` against a different view of the room merge into two
  // copies instead of replacing one another.
  //
  // `applied` says only that this window's Y.Doc was mutated; `acknowledged`
  // says the SERVER persisted it. They are reported separately because main
  // deletes the plan's markdown body from disk on the strength of the answer,
  // and a mutated-but-unacknowledged replica is precisely the state where the
  // file is the last remaining copy. Answering `{ applied: true }` alone -- as
  // this handler used to -- reads to main as durable.
  cleanups.push(
    window.electronAPI.on(
      'tracker-body:apply-markdown',
      (data: {
        workspacePath: string;
        itemId: string;
        markdown: string;
        responseChannel: string;
        expiresAt?: number;
      }) => {
        void (async () => {
          let applied = false;
          let acknowledged = false;
          try {
            if (
              data?.workspacePath &&
              typeof data.itemId === 'string' &&
              typeof data.markdown === 'string' &&
              !(typeof data.expiresAt === 'number' && Date.now() > data.expiresAt)
            ) {
              const outcome = await getBodyDocCache().applyMarkdownToWarmEntry(
                data.itemId,
                data.markdown,
                data.workspacePath,
              );
              applied = outcome !== 'no-entry';
              acknowledged = outcome === 'acknowledged';
            }
          } catch (error) {
            console.error('[trackerSyncListeners] Failed to apply agent body write:', error);
          } finally {
            if (data?.responseChannel) {
              window.electronAPI.send(data.responseChannel, { applied, acknowledged });
            }
          }
        })();
      },
    ),
  );
  cleanups.push(
    window.electronAPI.on(
      'tracker-navigation:changed',
      (data: { workspacePath: string }) => {
        if (!data?.workspacePath || data.workspacePath !== currentWorkspacePath) return;
        void store.set(loadTrackerNavigationAtom, data.workspacePath);
      },
    ),
  );
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
      const requestedWorkspacePath = currentWorkspacePath;
      const dataSource = bindTrackerDataSource(requestedWorkspacePath);

      void store.set(loadTrackerNavigationAtom, requestedWorkspacePath).catch((error) => {
        console.error('[trackerSyncListeners] Failed to load tracker navigation:', error);
      });
      // Initial load from the shared tracker read model (DB projection +
      // frontmatter-backed full-document items).
      try {
        const snapshot = await dataSource.snapshot();
        if (disposed || currentWorkspacePath !== requestedWorkspacePath) return;
        store.set(replaceAllTrackerItemsAtom, snapshot.items.map(trackerItemToRecord));
        remergeLocalWikiRecords(requestedWorkspacePath);
        store.set(replaceSharedTrackerViewsAtom, snapshot.savedViews);
        store.set(trackerSyncConnectionAtom, snapshot.sync);
      } catch (error) {
        console.error('[trackerSyncListeners] Failed to load tracker snapshot:', error);
        store.set(trackerDataLoadedAtom, true);
      }
      if (disposed || currentWorkspacePath !== requestedWorkspacePath) return;

      // Trigger a workspace scan to index new/changed files into PGLite.
      // The DocumentService skips scanning on startup for performance,
      // so without this, tracker items won't appear until an @ mention or file open.
      // Delay slightly to avoid blocking app startup.
      initialScanTimer = setTimeout(() => {
        if (trackerDataSource) void triggerWorkspaceScan(trackerDataSource);
      }, 3000);

      // Refetch when the user switches projects in the multi-project rail.
      // Without this, `currentWorkspacePath` stays pinned to the startup
      // workspace and the panel keeps showing the wrong project's items
      // (see GitHub #441). The IPC handlers resolve to the window's active
      // workspace, so a plain refetch after updating the filter is enough.
      const unsubscribeActivePath = store.sub(activeWorkspacePathAtom, () => {
        if (disposed) return;
        const nextPath = store.get(activeWorkspacePathAtom);
        if (!nextPath || nextPath === currentWorkspacePath) return;
        currentWorkspacePath = nextPath;
        // The previous project's wiki items leave the map now, not when the
        // snapshot lands: until then they would still open and edit its files.
        remergeLocalWikiRecords(nextPath);
        const nextDataSource = bindTrackerDataSource(nextPath);
        void initTrackerPanelLayout(nextPath);
        void store.set(loadTrackerNavigationAtom, nextPath).catch((error) => {
          console.error('[trackerSyncListeners] Failed to load tracker navigation after project switch:', error);
        });
        void nextDataSource.snapshot().then((snapshot) => {
          if (disposed || currentWorkspacePath !== nextPath) return;
          store.set(replaceAllTrackerItemsAtom, snapshot.items.map(trackerItemToRecord));
          remergeLocalWikiRecords(nextPath);
          store.set(replaceSharedTrackerViewsAtom, snapshot.savedViews);
          store.set(trackerSyncConnectionAtom, snapshot.sync);
        }).catch((error) => {
          console.error('[trackerSyncListeners] Failed to load tracker snapshot after project switch:', error);
          store.set(trackerDataLoadedAtom, true);
        });
      });
      cleanups.push(unsubscribeActivePath);
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
    if (relationshipReconcileTimer) {
      clearTimeout(relationshipReconcileTimer);
    }
    unsubscribeTrackerDataSource?.();
    trackerDataSource?.dispose();
    store.set(setTrackerDataSourceAtom, null);
    cleanups.forEach((cleanup) => cleanup());
  };
}
