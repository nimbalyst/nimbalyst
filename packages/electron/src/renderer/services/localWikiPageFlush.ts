/**
 * A Local wiki page open in a file tab can hold edits its autosave has not
 * written yet. Set type rewrites the file's frontmatter and Move to Team copies
 * the file, so both save the open editor first through the tab's own save
 * path; if that save does not happen, they stop rather than act on a stale file
 * (or have the editor's next save drop the change they made).
 */
import { getPersonalCollabHost } from '../store/atoms/collabDocuments';
import { DocumentModelRegistry } from './document-model/DocumentModelRegistry';

export class LocalWikiUnsavedEdits extends Error {
  constructor(title: string) {
    super(`"${title}" has edits that could not be saved to its file. Save the page, then try again.`);
    this.name = 'LocalWikiUnsavedEdits';
  }
}

/** Saves an open editor's pending edits to the page's file; throws `LocalWikiUnsavedEdits` when they stay unsaved. */
export async function flushLocalWikiPageEditor(workspacePath: string, documentId: string, title: string): Promise<void> {
  const filePath = getPersonalCollabHost(workspacePath).source().filePathsById().get(documentId);
  const model = filePath ? DocumentModelRegistry.get(filePath) : null;
  if (!model?.isDirty()) return;
  await model.flushDirtyEditors();
  if (model.isDirty()) throw new LocalWikiUnsavedEdits(title);
}
