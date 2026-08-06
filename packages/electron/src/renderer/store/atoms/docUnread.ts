/** Electron compatibility shim for package-owned document unread atoms. */

export {
  applyDocReceiptAtom,
  applyRemoteDocReceiptAtom,
  docReceiptsAtom,
  docSnapshot,
  docUnreadAtom,
  docUnreadByOrgAtom,
  recomputeDocUnreadAtom,
  setDocUnreadAtom,
} from '@nimbalyst/collab-client/docs';
