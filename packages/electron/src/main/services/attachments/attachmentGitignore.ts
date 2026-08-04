import { execFile } from 'child_process';
import { promisify } from 'util';
import { appendFile, readFile } from 'fs/promises';
import { join, normalize } from 'path';

const execFileAsync = promisify(execFile);
export const ATTACHMENT_GITIGNORE_ENTRY = 'nimbalyst-local/attachments/';

export interface AttachmentGitignoreStatus {
  isGitRepo: boolean;
  alreadyIgnored: boolean;
  shouldOffer: boolean;
}

async function gitTopLevel(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'rev-parse', '--show-toplevel']);
    return normalize(stdout.trim());
  } catch {
    return null;
  }
}

export async function getAttachmentGitignoreStatus(
  workspacePath: string,
): Promise<AttachmentGitignoreStatus> {
  const topLevel = await gitTopLevel(workspacePath);
  if (!topLevel) {
    return { isGitRepo: false, alreadyIgnored: false, shouldOffer: false };
  }

  try {
    await execFileAsync('git', [
      '-C',
      topLevel,
      'check-ignore',
      '--no-index',
      '-q',
      'nimbalyst-local/attachments/.nimbalyst-probe',
    ]);
    return { isGitRepo: true, alreadyIgnored: true, shouldOffer: false };
  } catch {
    return { isGitRepo: true, alreadyIgnored: false, shouldOffer: true };
  }
}

export async function appendAttachmentGitignore(
  workspacePath: string,
  enabled: boolean,
): Promise<{ appended: boolean; status: AttachmentGitignoreStatus }> {
  const status = await getAttachmentGitignoreStatus(workspacePath);
  if (!enabled || !status.shouldOffer) {
    return { appended: false, status };
  }

  const topLevel = await gitTopLevel(workspacePath);
  if (!topLevel) {
    return { appended: false, status: { isGitRepo: false, alreadyIgnored: false, shouldOffer: false } };
  }

  const gitignorePath = join(topLevel, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(gitignorePath, `${prefix}${ATTACHMENT_GITIGNORE_ENTRY}\n`, 'utf-8');
  return {
    appended: true,
    status: { isGitRepo: true, alreadyIgnored: true, shouldOffer: false },
  };
}
