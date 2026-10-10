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

/**
 * Page history: the dialog, its revisions client and the restore path. Loaded
 * when someone opens a page's history; the diff it draws is in `./editor`.
 */
export const loadPageHistory = () => import('@nimbalyst/collab-client/docs-ui/history');
export type {
  CollabHistoryController,
  CollabHistoryDialogProps,
  CollabHistoryDiffProps,
} from '@nimbalyst/collab-client/docs-ui/history';

/**
 * Set type: the sequence, its child moves, the type page's register step and
 * the picker dialog. Loaded when someone picks Set type, so the eager docs-ui
 * graph does not carry it.
 */
export const loadSetPageType = async () => ({
  ...(await import('@nimbalyst/collab-client/docs/pageTypes')),
  ...(await import('@nimbalyst/collab-client/docs-ui/setPageType')),
});
