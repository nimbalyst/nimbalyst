import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorNotificationService } from '../services/ErrorNotificationService';

export type CollabLocalOriginBinding = NonNullable<
  Awaited<ReturnType<typeof window.electronAPI.documentSync.getLocalOrigin>>['binding']
>;

type ReuploadResult = Awaited<
  ReturnType<typeof window.electronAPI.documentSync.reuploadLocalOrigin>
>;

function buildConflictPrompt(result: ReuploadResult): string {
  switch (result.conflictKind) {
    case 'missing-baseline':
      return 'No sync baseline exists for this local source yet. Overwrite the shared document with the current local file?';
    case 'shared-ahead':
      return 'The shared document changed since this local source was last linked. Overwrite the shared document with the current local file anyway?';
    case 'diverged':
      return 'Both the local file and the shared document changed. Overwrite the shared document with the current local file anyway?';
    default:
      return 'Overwrite the shared document with the current local file?';
  }
}

export function useCollabLocalOrigin(
  workspacePath: string,
  documentId: string | null | undefined,
  documentType?: string,
) {
  const [binding, setBinding] = useState<CollabLocalOriginBinding | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspacePath || !documentId || !window.electronAPI?.documentSync?.getLocalOrigin) {
      setBinding(null);
      return;
    }

    setLoading(true);
    try {
      const result = await window.electronAPI.documentSync.getLocalOrigin(workspacePath, documentId);
      if (result.success) {
        setBinding(result.binding ?? null);
      } else {
        setBinding(null);
      }
    } finally {
      setLoading(false);
    }
  }, [documentId, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasResolvedBinding = binding?.resolvedPath && binding.resolutionStatus !== 'missing';

  const openLocalSource = useCallback(async () => {
    if (!workspacePath || !binding?.resolvedPath) return false;
    await window.electronAPI.invoke('workspace:open-file', {
      workspacePath,
      filePath: binding.resolvedPath,
    });
    return true;
  }, [binding?.resolvedPath, workspacePath]);

  const relinkLocalSource = useCallback(async () => {
    if (!workspacePath || !documentId || !documentType || !window.electronAPI?.documentSync?.relinkLocalOrigin) {
      return false;
    }

    const result = await window.electronAPI.openFileDialog({
      title: 'Relink Local Source',
      defaultPath: binding?.resolvedPath ?? workspacePath,
      buttonLabel: 'Relink',
    });
    const selectedPath = result?.filePaths?.[0];
    if (result?.canceled || !selectedPath) {
      return false;
    }

    setBusyAction('relink');
    try {
      const relinkResult = await window.electronAPI.documentSync.relinkLocalOrigin({
        workspacePath,
        documentId,
        documentType,
        sourceFilePath: selectedPath,
      });
      if (!relinkResult.success) {
        errorNotificationService.showError(
          'Relink failed',
          relinkResult.error || 'Could not relink the local source.',
        );
        return false;
      }

      setBinding(relinkResult.binding ?? null);
      errorNotificationService.showInfo(
        'Local source linked',
        relinkResult.binding?.relativePath || 'The shared document is now linked to a local file.',
        { duration: 4000 },
      );
      return true;
    } finally {
      setBusyAction(null);
    }
  }, [binding?.resolvedPath, documentId, documentType, workspacePath]);

  const clearLocalSource = useCallback(async () => {
    if (!workspacePath || !documentId || !window.electronAPI?.documentSync?.clearLocalOrigin) {
      return false;
    }
    if (!window.confirm('Clear the local source link for this shared document?')) {
      return false;
    }

    setBusyAction('clear');
    try {
      const result = await window.electronAPI.documentSync.clearLocalOrigin(workspacePath, documentId);
      if (!result.success) {
        errorNotificationService.showError(
          'Clear failed',
          result.error || 'Could not clear the local source link.',
        );
        return false;
      }
      setBinding(null);
      errorNotificationService.showInfo(
        'Local source cleared',
        'This shared document no longer has a linked local file.',
        { duration: 3000 },
      );
      return true;
    } finally {
      setBusyAction(null);
    }
  }, [documentId, workspacePath]);

  const reuploadFromLocalSource = useCallback(async () => {
    if (!workspacePath || !documentId || !window.electronAPI?.documentSync?.reuploadLocalOrigin) {
      return false;
    }

    setBusyAction('reupload');
    try {
      let result = await window.electronAPI.documentSync.reuploadLocalOrigin({
        workspacePath,
        documentId,
      });

      if (result.status === 'conflict') {
        const confirmed = window.confirm(buildConflictPrompt(result));
        if (!confirmed) return false;
        result = await window.electronAPI.documentSync.reuploadLocalOrigin({
          workspacePath,
          documentId,
          forceOverwriteShared: true,
        });
      }

      if (result.success && result.binding !== undefined) {
        setBinding(result.binding ?? null);
      }

      switch (result.status) {
        case 'uploaded': {
          const migrationSummary = result.migration && (result.migration.okCount > 0 || result.migration.failedCount > 0)
            ? ` Uploaded ${result.migration.okCount} attachment${result.migration.okCount === 1 ? '' : 's'}${result.migration.failedCount > 0 ? `; ${result.migration.failedCount} failed.` : '.'}`
            : '';
          errorNotificationService.showInfo(
            'Shared document updated',
            `${result.message || 'Uploaded the current local file to the shared document.'}${migrationSummary}`,
            { duration: 5000 },
          );
          return true;
        }
        case 'noop':
          errorNotificationService.showInfo(
            'Nothing to upload',
            result.message || 'The local file already matches the shared document baseline.',
            { duration: 3500 },
          );
          return true;
        case 'missing-source':
        case 'unsupported':
        case 'error':
        default:
          errorNotificationService.showError(
            'Re-upload failed',
            result.message || 'Could not re-upload from the local source.',
          );
          return false;
      }
    } finally {
      setBusyAction(null);
    }
  }, [documentId, workspacePath]);

  return useMemo(() => ({
    binding,
    busyAction,
    hasResolvedBinding: !!hasResolvedBinding,
    loading,
    refresh,
    openLocalSource,
    relinkLocalSource,
    clearLocalSource,
    reuploadFromLocalSource,
  }), [
    binding,
    busyAction,
    hasResolvedBinding,
    loading,
    refresh,
    openLocalSource,
    relinkLocalSource,
    clearLocalSource,
    reuploadFromLocalSource,
  ]);
}

export function useLocalFileSharedDocLink(
  workspacePath: string,
  sourceFilePath: string | null | undefined,
) {
  const [binding, setBinding] = useState<CollabLocalOriginBinding | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspacePath || !sourceFilePath || !window.electronAPI?.documentSync?.findLocalOriginLink) {
      setBinding(null);
      return;
    }

    setLoading(true);
    try {
      const result = await window.electronAPI.documentSync.findLocalOriginLink(workspacePath, sourceFilePath);
      if (result.success) {
        setBinding(result.binding ?? null);
      } else {
        setBinding(null);
      }
    } finally {
      setLoading(false);
    }
  }, [sourceFilePath, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reuploadToSharedDoc = useCallback(async () => {
    if (!workspacePath || !binding?.documentId || !window.electronAPI?.documentSync?.reuploadLocalOrigin) {
      return false;
    }

    setBusyAction('reupload');
    try {
      let result = await window.electronAPI.documentSync.reuploadLocalOrigin({
        workspacePath,
        documentId: binding.documentId,
      });

      if (result.status === 'conflict') {
        const confirmed = window.confirm(buildConflictPrompt(result));
        if (!confirmed) return false;
        result = await window.electronAPI.documentSync.reuploadLocalOrigin({
          workspacePath,
          documentId: binding.documentId,
          forceOverwriteShared: true,
        });
      }

      if (result.success && result.binding !== undefined) {
        setBinding(result.binding ?? null);
      }

      switch (result.status) {
        case 'uploaded': {
          const migrationSummary = result.migration && (result.migration.okCount > 0 || result.migration.failedCount > 0)
            ? ` Uploaded ${result.migration.okCount} attachment${result.migration.okCount === 1 ? '' : 's'}${result.migration.failedCount > 0 ? `; ${result.migration.failedCount} failed.` : '.'}`
            : '';
          errorNotificationService.showInfo(
            'Shared document updated',
            `${result.message || 'Uploaded the current local file to the shared document.'}${migrationSummary}`,
            { duration: 5000 },
          );
          return true;
        }
        case 'noop':
          errorNotificationService.showInfo(
            'Nothing to upload',
            result.message || 'The local file already matches the shared document baseline.',
            { duration: 3500 },
          );
          return true;
        case 'missing-source':
        case 'unsupported':
        case 'error':
        default:
          errorNotificationService.showError(
            'Re-upload failed',
            result.message || 'Could not re-upload from the local source.',
          );
          return false;
      }
    } finally {
      setBusyAction(null);
    }
  }, [binding?.documentId, workspacePath]);

  return useMemo(() => ({
    binding,
    busyAction,
    loading,
    refresh,
    reuploadToSharedDoc,
  }), [
    binding,
    busyAction,
    loading,
    refresh,
    reuploadToSharedDoc,
  ]);
}
