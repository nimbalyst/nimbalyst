import type {
  TrackerItem,
  TrackerItemChangeEvent,
} from '@nimbalyst/runtime/core/DocumentService';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { generateKeyBetween } from '@nimbalyst/runtime/utils/fractionalIndex';
import { database } from '../../database/PGLiteDatabaseWorker';
import { getCurrentIdentity } from '../TrackerIdentityService';
import {
  getEffectiveTrackerSharingPolicy,
  getInitialTrackerSyncStatus,
} from '../TrackerPolicyService';
import {
  creationRequestHash,
  getCreationReceipt,
  withCreationLock,
} from './trackerCreationReceipt';
import { initialTrackerBodyCache } from './trackerBodySnapshot';

export interface NativeTrackerCreatePayload {
  id: string;
  type: string;
  title: string;
  status: string;
  priority: string;
  workspace: string;
  description?: string;
  owner?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
  content?: unknown;
  source?: string;
  sourceRef?: string;
  sharing?: 'personal' | 'team';
  draftByDefault?: boolean;
  /** Stable across retries of one quick-create submission. */
  creationRequestId?: string;
}

/** The transaction committed; callers must report partial success rather than invite another create. */
export class TrackerCreationCommittedError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly shared: boolean,
    cause: unknown,
  ) {
    super(
      `Item saved locally, but refreshing it failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

interface CreationDependencies {
  assignLocalKeysFrom: (rows: any[]) => Promise<void>;
  rowToTrackerItem: (row: any) => TrackerItem;
  notify: (change: TrackerItemChangeEvent) => void;
}

export async function createNativeTrackerItem(
  payload: NativeTrackerCreatePayload,
  dependencies: CreationDependencies,
): Promise<TrackerItem> {
  return withCreationLock(payload.workspace, payload.id, () =>
    createRow(payload, dependencies),
  );
}

async function createRow(
  payload: NativeTrackerCreatePayload,
  dependencies: CreationDependencies,
): Promise<TrackerItem> {
  if (
    !payload.workspace ||
    !payload.id ||
    !payload.type ||
    !payload.title?.trim()
  )
    throw new Error('Workspace, item ID, type, and title are required');
  if (payload.creationRequestId && payload.creationRequestId !== payload.id)
    throw new Error('Creation request ID must match the item ID');
  const requestHash = payload.creationRequestId
    ? creationRequestHash(payload)
    : null;
  if (requestHash) {
    const receipt = await getCreationReceipt(payload.workspace, payload.id);
    if (receipt) {
      if (receipt.request_hash !== requestHash)
        throw new Error(
          'This creation already saved a different draft. Open the saved item before submitting changes.',
        );
      const existing = await database.query(
        'SELECT * FROM tracker_items WHERE id = $1 AND workspace = $2',
        [payload.id, payload.workspace],
      );
      if (!existing.rows[0])
        throw new Error('The previously created item is no longer available');
      await dependencies.assignLocalKeysFrom(existing.rows);
      return dependencies.rowToTrackerItem(existing.rows[0]);
    }
  }
  // Check if this type allows creation
  const model = globalRegistry.get(payload.type);
  if (model && model.creatable === false) {
    throw new Error(
      `Cannot create items of type '${payload.type}': type is not creatable`,
    );
  }

  // Stamp author identity on creation
  // getCurrentIdentity imported statically at top of file
  const authorIdentity = getCurrentIdentity(payload.workspace);

  // Assign initial kanbanSortOrder: place new items at the top of their column.
  // Query the current minimum sort key for this workspace+status so the new item sorts before it.
  let initialSortOrder = 'a0';
  try {
    const minKeyResult = await database.query<any>(
      `SELECT MIN(kanban_sort_order) as min_key FROM tracker_items WHERE workspace = $1 AND status = $2 AND kanban_sort_order IS NOT NULL`,
      [payload.workspace, payload.status],
    );
    const minKey = minKeyResult.rows[0]?.min_key;
    if (minKey) {
      initialSortOrder = generateKeyBetween(null, minKey);
    }
  } catch (e) {
    // Non-fatal: fall back to default sort order
  }

  const data: Record<string, any> = {
    title: payload.title,
    status: payload.status,
    priority: payload.priority,
    kanbanSortOrder: initialSortOrder,
    created: new Date().toISOString().split('T')[0],
    authorIdentity,
    reporterEmail: authorIdentity.email || authorIdentity.gitEmail || undefined,
  };
  if (payload.description) data.description = payload.description;
  if (payload.owner) data.owner = payload.owner;
  if (payload.tags && payload.tags.length > 0) data.tags = payload.tags;
  if (payload.customFields) {
    Object.assign(data, payload.customFields);
  }

  const source = payload.source || 'native';
  const contentJson =
    payload.content != null ? JSON.stringify(payload.content) : null;
  const sharingPolicy = getEffectiveTrackerSharingPolicy(
    payload.workspace,
    payload.type,
    payload,
  );
  const syncStatus = getInitialTrackerSyncStatus(sharingPolicy, data);

  // NIM-454: persist the tracker-type tag on the row so the item reliably
  // appears in its type view and syncs correctly, instead of relying on a
  // read-time fallback. Mirrors the MCP create path (typeTags always includes
  // the primary type). The DB layer maps a JS array to TEXT[] on PGLite / a
  // JSON string on better-sqlite3.
  const typeTags: string[] = [payload.type];

  const statements: Array<{ sql: string; params: any[] }> = [
    {
      sql: `INSERT INTO tracker_items (
        id, type, type_tags, data, workspace, document_path, line_number,
        created, updated, last_indexed, sync_status,
        content, archived, source, source_ref, body_version
      ) VALUES ($1, $2, $3, $4, $5, '', NULL, NOW(), NOW(), NOW(), $6, $7, FALSE, $8, $9, $10)`,
      params: [
        payload.id,
        payload.type,
        typeTags,
        JSON.stringify(data),
        payload.workspace,
        syncStatus,
        contentJson,
        source,
        payload.sourceRef || null,
        contentJson === null ? 0 : 1,
      ],
    },
  ];
  if (contentJson !== null)
    statements.push(initialTrackerBodyCache(payload.id, contentJson));
  if (requestHash)
    statements.push({
      sql: 'INSERT INTO tracker_creation_receipts (item_id, workspace, request_hash, publication_status) VALUES ($1, $2, $3, $4)',
      params: [
        payload.id,
        payload.workspace,
        requestHash,
        syncStatus === 'pending' ? 'pending' : 'local',
      ],
    });
  await database.runTransaction(statements);

  try {
    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [payload.id],
    );
    if (result.rows.length === 0) {
      throw new Error(`Failed to create tracker item ${payload.id}`);
    }

    // The insert leaves `local_key` NULL. Sweep before mapping, so the item
    // handed to the watcher -- which the renderer inserts optimistically --
    // carries its number instead of rendering keyless until the next re-list.
    await dependencies.assignLocalKeysFrom(result.rows);

    const created = dependencies.rowToTrackerItem(result.rows[0]);

    // Notify watchers
    const changeEvent: TrackerItemChangeEvent = {
      added: [created],
      updated: [],
      removed: [],
      timestamp: new Date(),
    };
    dependencies.notify(changeEvent);

    return created;
  } catch (error) {
    if (payload.creationRequestId)
      throw new TrackerCreationCommittedError(
        payload.id,
        syncStatus === 'pending',
        error,
      );
    throw error;
  }
}
