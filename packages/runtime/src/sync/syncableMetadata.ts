/**
 * Declarative list of session-metadata fields that should reach other devices
 * via the sync layer. SyncedSessionStore.updateMetadata and create() both
 * derive their push payloads from this list, so adding a new sync-relevant
 * field is a one-line change here instead of an audit of every IPC handler
 * and service that calls AISessionsRepository.updateMetadata.
 *
 * Past incident: pin/unpin, drag-drop reparent, MCP `update_session_meta`,
 * and the blitz `hasBeenNamed` flag all silently failed to reach iOS because
 * each caller was expected to remember its own `pushChange` after writing.
 * Routing the decision through the store eliminates that failure mode.
 */
export const SYNC_RELEVANT_FIELDS = {
  /**
   * Top-level columns on `ai_sessions` that map 1:1 to fields on the
   * SyncedSessionMetadata wire shape. Anything listed here is forwarded
   * when present in the updateMetadata payload (and from create()).
   */
  columns: [
    'title',
    'mode',
    'isArchived',
    'isPinned',
    'hasBeenNamed',
    'provider',
    'model',
    'sessionType',
    'parentSessionId',
    'worktreeId',
  ] as const,

  /**
   * Keys inside the `metadata` JSONB blob that get promoted onto the wire.
   * Stored locally as `payload.metadata.<key>` but flattened into the top
   * level of SyncedSessionMetadata when pushed.
   */
  metadataKeys: ['phase', 'tags'] as const,

  /**
   * Subset of `columns` whose changes represent meaningful content activity
   * and so should bump `updatedAt` (driving sort order on iOS). Pins,
   * archives, reparents, etc. deliberately do NOT bump this — that would
   * cause the row to jump to the top of the list on every device.
   */
  sortRelevantColumns: ['title', 'mode', 'isArchived', 'provider', 'model'] as const,
} as const;

export type SyncRelevantColumn = (typeof SYNC_RELEVANT_FIELDS.columns)[number];
export type SyncRelevantMetadataKey = (typeof SYNC_RELEVANT_FIELDS.metadataKeys)[number];

/**
 * Returns true if a sort-relevant field is being changed, in which case
 * the pushed payload should also include a fresh `updatedAt`.
 */
export function hasSortRelevantChange(payload: Record<string, unknown>): boolean {
  return SYNC_RELEVANT_FIELDS.sortRelevantColumns.some(
    (field) => payload[field] !== undefined
  );
}
