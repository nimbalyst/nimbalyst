/**
 * Shared-document page history: the dialog, the controller a host hands it,
 * and the restore write path. Editor-free; the rich markdown diff is the
 * runtime DiffPlugin's `DiffPreviewEditor`, which the host supplies.
 */
export { CollabHistoryDialog } from './CollabHistoryDialog';
export type {
  CollabHistoryDialogProps,
  CollabHistoryDiffNavigationState,
  CollabHistoryDiffProps,
} from './CollabHistoryDialog';
export {
  canRestoreCollabRevisions,
  isCollabRestoreSafe,
  restoreCollabRevision,
  type CollabHistoryController,
} from './collabHistoryController';
export {
  AUTO_REVISION_IDLE_MS,
  AUTO_REVISION_MIN_INTERVAL_MS,
  AUTO_REVISION_POLL_MS,
  CollabRevisionRecorder,
  startCollabRevisionRecording,
} from './collabRevisionRecorder';
export {
  loadCollabHistoryCompare,
  planCollabHistoryCompare,
  type CollabHistoryCompareContent,
  type CollabHistoryCompareLoaders,
  type CollabHistoryCompareMode,
  type CollabHistoryComparePlan,
  type CollabHistorySide,
} from './collabHistoryCompare';
export { CollabHistoryClient, CollabHistoryError } from '@nimbalyst/runtime/sync/collabHistoryClient';
