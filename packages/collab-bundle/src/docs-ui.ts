/**
 * Shared Docs shell and headless-session entry.
 *
 * This entry deliberately stays separate from `./editor`. The shell and the
 * session factory must stay together so their Jotai atoms and runtime store
 * are instantiated by one prebuilt module graph.
 */
export * from '@nimbalyst/collab-client/docs';
export * from '@nimbalyst/collab-client/docs-ui';
export {
  appendSyncClientParams,
  getSyncClientInfo,
  setSyncClientInfo,
  type SyncClientInfo,
} from '@nimbalyst/runtime/sync/syncClientInfo';
