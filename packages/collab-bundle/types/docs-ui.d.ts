/**
 * Shared Docs shell and headless-session entry.
 *
 * This entry deliberately stays separate from `./editor`. The shell and the
 * session factory must stay together so their Jotai atoms and runtime store
 * are instantiated by one prebuilt module graph.
 */
export * from './internal/collab-client/src/docs/index';
export * from './internal/collab-client/src/docs-ui/index';
export { appendSyncClientParams, getSyncClientInfo, setSyncClientInfo, type SyncClientInfo, } from './internal/runtime/src/sync/syncClientInfo';
