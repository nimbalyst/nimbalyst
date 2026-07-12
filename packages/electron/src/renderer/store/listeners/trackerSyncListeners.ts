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
import type { TrackerItem, TrackerItemChangeEvent } from '@nimbalyst/runtime';
import { trackerItemToRecord, type TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, isRelationshipField } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerSyncConfigChangeAtom, trackerSyncConnectionAtom, trackerSyncRejectionAtom, type TrackerSyncRejectionCode } from '../atoms/trackerSync';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { loadTrackerNavigationAtom } from '../atoms/trackerNavigation';

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
async function loadAllTrackerItems(): Promise<void> {
  try {
    const items = await window.electronAPI.invoke('document-service:tracker-items-list') as TrackerItem[];
    const records = (items || []).map(trackerItemToRecord);
    store.set(replaceAllTrackerItemsAtom, records);
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
  let relationshipReconcileTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounced safety net: after a relationship-bearing change event, reload the
  // full tracker read model so a partial/out-of-order granular upsert can't
  // leave relationship fields stale in the panel (NIM-1305).
  const scheduleRelationshipReconcile = () => {
    if (disposed) return;
    if (relationshipReconcileTimer) clearTimeout(relationshipReconcileTimer);
    relationshipReconcileTimer = setTimeout(() => {
      relationshipReconcileTimer = null;
      if (disposed) return;
      void loadAllTrackerItems();
    }, RELATIONSHIP_RECONCILE_DEBOUNCE_MS);
  };

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
  cleanups.push(
    window.electronAPI.on('tracker-sync:status-changed', (value: string | { workspacePath: string; status: string; shared?: boolean }) => {
      if (!currentWorkspacePath) return;
      const status = typeof value === 'string' ? value : value.status;
      const eventWorkspace = typeof value === 'string' ? currentWorkspacePath : value.workspacePath;
      if (eventWorkspace !== currentWorkspacePath) return;
      const current = store.get(trackerSyncConnectionAtom);
      store.set(trackerSyncConnectionAtom, {
        workspacePath: currentWorkspacePath,
        status,
        projectId: typeof value !== 'string' && value.shared
          ? 'shared'
          : current?.workspacePath === currentWorkspacePath ? current.projectId : null,
      });
    }),
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

      void store.set(loadTrackerNavigationAtom, requestedWorkspacePath).catch((error) => {
        console.error('[trackerSyncListeners] Failed to load tracker navigation:', error);
      });
      void window.electronAPI.invoke(
        'tracker-sync:get-status',
        { workspacePath: requestedWorkspacePath },
      ).then((syncStatus: { status?: string; projectId?: string | null } | undefined) => {
        if (disposed || !syncStatus || currentWorkspacePath !== requestedWorkspacePath) return;
        store.set(trackerSyncConnectionAtom, {
          workspacePath: requestedWorkspacePath,
          status: syncStatus.status ?? 'disconnected',
          projectId: syncStatus.projectId ?? null,
        });
      }).catch((error: unknown) => {
        console.error('[trackerSyncListeners] Failed to load tracker sync status:', error);
      });

      // Initial load from the shared tracker read model (DB projection +
      // frontmatter-backed full-document items).
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
            let sawRelationshipChange = false;
            if (change.added?.length) {
              for (const item of change.added) {
                if (!belongsToThisWorkspace(item)) continue;
                store.set(upsertTrackerItemAtom, trackerItemToRecord(item));
                if (itemCarriesRelationshipField(item)) sawRelationshipChange = true;
              }
            }
            if (change.updated?.length) {
              for (const item of change.updated) {
                if (!belongsToThisWorkspace(item)) continue;
                store.set(upsertTrackerItemAtom, trackerItemToRecord(item));
                if (itemCarriesRelationshipField(item)) sawRelationshipChange = true;
              }
            }
            if (change.removed?.length) {
              for (const id of change.removed) {
                store.set(removeTrackerItemAtom, id);
              }
            }

            // Relationship-bearing changes can land via inverse propagation as a
            // burst of out-of-order partial events; reconcile from the read model
            // so the detail panel never sticks on stale `No links` (NIM-1305).
            if (sawRelationshipChange) scheduleRelationshipReconcile();
          }
        )
      );

      // Metadata changes can add/remove/update full-document tracker items, so
      // re-fetch the merged read model whenever frontmatter changes.
      window.electronAPI.send('document-service:metadata-watch');

      cleanups.push(
        window.electronAPI.on('document-service:metadata-changed', () => {
          void loadAllTrackerItems();
        })
      );

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
        void loadAllTrackerItems();
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
    cleanups.forEach((cleanup) => cleanup());
  };
}
