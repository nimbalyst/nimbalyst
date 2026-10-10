/**
 * Add from Files... in Pages: pick a file on disk and copy it in as a page, in
 * the section and under the page the author started from. The copy goes
 * through the same dialog and the same share flow as Copy to Pages... in the
 * Files tree, so the file types, image upload, linked documents and the link
 * back to the local file all behave the same.
 */
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { errorNotificationService } from './ErrorNotificationService';
import { getFileName } from '../utils/pathUtils';
import { askShareToTeam, shareFileToTeam, type PagesSection } from './shareToTeamFlow';

export async function addFileToPages(target: {
  section: PagesSection;
  /** The page it goes inside; null for the top of the section. */
  parentId: string | null;
  /** Where the picker starts; the open project when absent. */
  workspacePath?: string | null;
}): Promise<void> {
  const startIn = target.workspacePath ?? store.get(activeWorkspacePathAtom);
  const picked = await window.electronAPI.openFileDialog({
    title: 'Add from Files',
    buttonLabel: 'Add',
    ...(startIn ? { defaultPath: startIn } : {}),
  });
  const filePath = picked?.filePaths?.[0];
  if (picked?.canceled || !filePath) return;
  const fileName = getFileName(filePath);
  const ask = await askShareToTeam(
    { filePath, fileName },
    { section: target.section, destination: { folderId: target.parentId, folderPath: '' } },
  );
  if (ask.status === 'unavailable') {
    errorNotificationService.showError(`Could not add ${fileName}`, ask.reason);
    return;
  }
  if (ask.status !== 'answered') return;
  await shareFileToTeam({ filePath, fileName, answers: ask.answers });
}
