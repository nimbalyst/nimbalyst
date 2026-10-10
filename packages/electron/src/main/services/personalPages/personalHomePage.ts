/**
 * The Personal section's Home page, seeded once per workspace. The `home:`
 * prefix is what the Pages tree pins first (collab-client `docs/homePage.ts`);
 * the TeamRoom seeds the team's Home the same way. The seeded-once flag lives
 * in workspace state, so a Home the user renamed, edited or deleted is never
 * restored or overwritten.
 */
import { getWorkspaceState, updateWorkspaceState } from '../../utils/store';
import { insertDocumentIfAbsent, type PersonalPagesDb } from './personalPagesStore';

export const PERSONAL_HOME_PAGE_ID = 'home:personal';

export const PERSONAL_HOME_MARKDOWN = [
  'This is your personal home page. Pages in the Personal section stay on this device.',
  '',
  'To add a page, right-click empty space in the sidebar or the Personal heading and choose New page. Right-click any page to add a page inside it.',
  '',
  'You can edit, rename, move or delete this page like any other.',
  '',
].join('\n');

export interface PersonalHomeSeedFlags {
  seeded(workspacePath: string): boolean;
  markSeeded(workspacePath: string): void;
}

/** The flag in workspace state (survives a relaunch, per workspace). */
export const workspaceStateHomeSeedFlags: PersonalHomeSeedFlags = {
  seeded: (workspacePath) => getWorkspaceState(workspacePath).personalPagesHomeSeededAt != null,
  markSeeded: (workspacePath) => {
    updateWorkspaceState(workspacePath, (state) => {
      state.personalPagesHomeSeededAt = Date.now();
    });
  },
};

/**
 * Seed Home unless this workspace was seeded before. The insert never
 * overwrites, so a crash before the flag is written only repeats a no-op.
 */
export async function seedPersonalHomeOnce(db: PersonalPagesDb, workspacePath: string, flags: PersonalHomeSeedFlags): Promise<boolean> {
  if (flags.seeded(workspacePath)) return false;
  await insertDocumentIfAbsent(db, workspacePath, {
    documentId: PERSONAL_HOME_PAGE_ID,
    title: 'Home',
    fileExtension: '.md',
    editorId: 'builtin.lexical',
    body: PERSONAL_HOME_MARKDOWN,
  });
  flags.markSeeded(workspacePath);
  return true;
}
