import { getCollabContentAdapter } from '@nimbalyst/collab-adapters';

import { safeHandle } from '../utils/ipcRegistry';
import { getLocalOriginBinding } from '../services/CollabLocalOriginService';
import { getCollabBackupService } from '../services/CollabBackupService';
import { backupCollabProject, restoreCollabBackup } from '../services/CollabBackupCoordinator';
import { findTeamForWorkspace } from '../services/TeamService';

export function registerCollabBackupHandlers(): void {
  safeHandle('collab-backup:content-changed', async (_event, payload: {
    workspacePath: string;
    documentId: string;
    documentType: string;
    title?: string;
    plaintext: string;
    kind?: 'document' | 'body';
  }) => {
    if (!payload?.workspacePath || !payload.documentId || typeof payload.plaintext !== 'string') {
      return { success: false, error: 'workspacePath, documentId, and plaintext required' };
    }
    const team = await findTeamForWorkspace(payload.workspacePath);
    if (!team) return { success: false, error: 'No team found for this workspace' };
    const trackerBody = payload.documentId.startsWith('tracker-content/');
    if (payload.kind === 'body' && !trackerBody) {
      return { success: false, error: 'Tracker body documentId must start with tracker-content/' };
    }
    const kind = trackerBody ? 'body' : 'document';
    const binding = kind === 'document'
      ? await getLocalOriginBinding(payload.workspacePath, payload.documentId)
      : null;
    if (kind === 'document' && !binding) {
      return { success: false, error: 'No local-origin binding for collaborative document' };
    }
    const documentType = kind === 'body'
      ? 'markdown'
      : (binding?.documentType ?? payload.documentType ?? 'markdown');
    const adapter = getCollabContentAdapter(documentType);
    if (!adapter) return { success: false, error: `No adapter for ${documentType}` };
    getCollabBackupService().onContentChanged({
      documentId: payload.documentId,
      orgId: team.orgId,
      projectId: team.teamProjectId ?? null,
      documentType,
      title: payload.title || binding?.sourceBasename || payload.documentId,
      relativePath: binding?.relativePath ?? null,
      kind,
      extension: adapter.fileExtensions[0] ?? '.txt',
      getPlaintext: () => payload.plaintext,
    });
    return { success: true, scheduled: true };
  });

  safeHandle('collab-backup:backup-all', async (_event, payload: { workspacePath: string }) => {
    if (!payload?.workspacePath) throw new Error('workspacePath required');
    return backupCollabProject(payload.workspacePath);
  });

  safeHandle('collab-backup:list', async (_event, payload: { workspacePath: string }) => {
    if (!payload?.workspacePath) throw new Error('workspacePath required');
    const team = await findTeamForWorkspace(payload.workspacePath);
    if (!team) return null;
    return getCollabBackupService().listProjectBackups(team.orgId, team.teamProjectId ?? null);
  });

  safeHandle('collab-backup:restore', async (_event, payload: {
    workspacePath: string;
    documentId: string;
    force?: boolean;
  }) => {
    if (!payload?.workspacePath || !payload.documentId) {
      return { success: false, error: 'workspacePath and documentId required' };
    }
    return restoreCollabBackup({
      workspacePath: payload.workspacePath,
      documentId: payload.documentId,
      force: payload.force === true,
    });
  });
}
