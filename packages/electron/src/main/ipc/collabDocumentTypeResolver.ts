/**
 * Helper for `document-sync:open` to recover the `documentType` of a
 * shared document when the caller didn't provide one.
 *
 * The bug this defends against: pre-fix `CollabMode.loadOpenCollabDocs` /
 * `TabContent.loadContent` restore paths called the IPC without
 * documentType. `CollaborativeTabEditor` then defaulted to `markdown`,
 * routing a shared `.excalidraw` / `.mockup.html` Y.Doc through Lexical
 * and rendering a blank pane. The renderer fix carries documentType
 * through persistence; this helper ensures the IPC also recovers it
 * locally so any future caller that forgets gets the right editor.
 *
 * Kept pure (no side effects, no Electron imports) so it can be unit
 * tested without standing up the whole main process.
 */
export interface PersistedCollabEntryShape {
  documentId?: string;
  documentType?: string;
}

export interface WorkspaceStateForCollabDocType {
  openCollabDocumentEntries?: unknown;
}

export function resolveCollabDocumentType(args: {
  /** documentType explicitly passed by the IPC caller, if any. */
  callerDocumentType?: string;
  /** Workspace state read from electron-store. */
  workspaceState: WorkspaceStateForCollabDocType;
  /** documentId being opened. */
  documentId: string;
}): string | undefined {
  if (args.callerDocumentType) return args.callerDocumentType;

  const entries = args.workspaceState.openCollabDocumentEntries;
  if (!Array.isArray(entries)) return undefined;

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as PersistedCollabEntryShape;
    if (typeof e.documentId !== 'string') continue;
    if (typeof e.documentType !== 'string') continue;
    if (e.documentId === args.documentId) return e.documentType;
  }
  return undefined;
}
