import type { IpcMainInvokeEvent } from 'electron';
import { MAX_COLLAB_ASSET_BYTES } from '@nimbalyst/runtime/sync/collabAssetFormat';
import { safeHandle } from '../utils/ipcRegistry';
import { database } from '../database/PGLiteDatabaseWorker';
import type { ElectronDocumentService } from '../services/ElectronDocumentService';
import {
  TrackerCreationCommittedError,
  type NativeTrackerCreatePayload,
} from '../services/tracker/createNativeTrackerItem';
import {
  bodyMarkdown,
  getTrackerCreationPublication,
  publishTrackerCreation,
} from '../services/tracker/publishTrackerCreation';
import { registerTrackerCreationResume } from '../services/tracker/trackerCreationResume';
import {
  getEffectiveTrackerSharingPolicy,
  shouldSyncTrackerItem,
} from '../services/TrackerPolicyService';
import {
  isTrackerSyncActive,
  syncTrackerItem,
} from '../services/TrackerSyncManager';

export function registerTrackerCreationHandlers(
  resolveService: (event: IpcMainInvokeEvent) => ElectronDocumentService,
  onCreated: (
    item: Awaited<ReturnType<ElectronDocumentService['createTrackerItem']>>,
    shared: boolean,
  ) => void,
): void {
  registerTrackerCreationResume();
  safeHandle(
    'document-service:create-tracker-item',
    async (event, payload: NativeTrackerCreatePayload) => {
      let committedItem:
        | Awaited<ReturnType<ElectronDocumentService['createTrackerItem']>>
        | undefined;
      let shared = false;
      try {
        const service = resolveService(event);
        // Legacy callers retain their contract; retryable creation is explicitly scoped.
        if (payload.creationRequestId)
          service.assertWorkspace(payload.workspace);
        const item = await service.createTrackerItem(payload);
        committedItem = item;
        shared = item.syncStatus === 'pending';
        const policy = getEffectiveTrackerSharingPolicy(
          payload.workspace,
          payload.type,
          payload,
        );
        if (
          !payload.creationRequestId &&
          shouldSyncTrackerItem(policy, item) &&
          isTrackerSyncActive(payload.workspace)
        ) {
          try {
            await syncTrackerItem(item);
          } catch (error) {
            console.error('[TrackerCreation] Metadata sync failed:', error);
          }
        }
        shared = shouldSyncTrackerItem(policy, item);
        onCreated(item, shared);
        return {
          success: true,
          item,
          publication: payload.creationRequestId
            ? await getTrackerCreationPublication(payload.workspace, item.id)
            : undefined,
        };
      } catch (error) {
        if (
          payload?.creationRequestId &&
          (committedItem || error instanceof TrackerCreationCommittedError)
        ) {
          const pending =
            error instanceof TrackerCreationCommittedError
              ? error.shared
              : shared;
          return {
            success: true,
            item: committedItem,
            publication: {
              itemId: payload.id,
              status: pending ? 'pending' : 'local',
              error: error instanceof Error ? error.message : String(error),
              ...(pending
                ? { savedContent: bodyMarkdown(payload.content) }
                : {}),
            },
          };
        }
        console.error('[TrackerCreation] create-tracker-item failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  safeHandle(
    'tracker-creation:publish',
    async (event, payload: { workspacePath: string; itemId: string }) => {
      const service = resolveService(event);
      service.assertWorkspace(payload?.workspacePath);
      if (!payload.itemId) throw new Error('Item ID is required');
      return publishTrackerCreation(payload.workspacePath, payload.itemId, {
        getItem: (id) => service.getTrackerItemById(id),
      });
    },
  );

  safeHandle(
    'tracker-creation:status',
    async (event, payload: { workspacePath: string; itemId: string }) => {
      resolveService(event).assertWorkspace(payload?.workspacePath);
      if (!payload.itemId) throw new Error('Item ID is required');
      return getTrackerCreationPublication(
        payload.workspacePath,
        payload.itemId,
      );
    },
  );

  safeHandle(
    'tracker-creation:pending',
    async (event, payload: { workspacePath: string }) => {
      resolveService(event).assertWorkspace(payload?.workspacePath);
      const result = await database.query<{ item_id: string }>(
        "SELECT item_id FROM tracker_creation_receipts WHERE workspace = $1 AND publication_status = 'pending' ORDER BY updated DESC LIMIT 100",
        [payload.workspacePath],
      );
      return result.rows.map((row) => row.item_id);
    },
  );

  safeHandle(
    'tracker-creation:stage-image',
    async (
      event,
      payload: { workspacePath: string; bytes: ArrayBuffer; mimeType: string },
    ) => {
      const service = resolveService(event);
      service.assertWorkspace(payload?.workspacePath);
      if (
        !payload.bytes?.byteLength ||
        payload.bytes.byteLength > MAX_COLLAB_ASSET_BYTES
      )
        throw new Error('Screenshot must be between 1 byte and 25 MB');
      if (
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
          payload.mimeType,
        )
      )
        throw new Error('Use a PNG, JPEG, GIF, or WebP screenshot');
      // Workspace-level content-addressed storage: no ambient active document and
      // no team upload until the item has actually been submitted.
      return service.storeAsset(Buffer.from(payload.bytes), payload.mimeType);
    },
  );
}
