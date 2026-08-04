export {
  UNRESOLVED_SHARED_DOCUMENT_NAME,
  buildCollabTree,
  buildCollabTreeAdaptive,
  buildCollabTreeFromFolders,
  computeLegacyFolderRenameUpdates,
  filterCollabTree,
  flattenCollabFolderOptions,
  getCollabDocumentPath,
  getCollabNodeName,
  getCollabParentPath,
  getSharedDocumentDisplayName,
  getSharedDocumentDisplayPath,
  getSharedDocumentDisplayPathWithFallback,
  joinCollabPath,
  normalizeCollabPath,
  pruneEmptyFolders,
  reconcileSharedDocumentDisplayName,
  renameCollabDocumentPath,
  resolveCollabCreateTargetFolderId,
} from '@nimbalyst/collab-client/docs';

export type {
  CollabFolderOption,
  CollabTreeDocumentNode,
  CollabTreeFolderNode,
  CollabTreeNode,
} from '@nimbalyst/collab-client/docs';
