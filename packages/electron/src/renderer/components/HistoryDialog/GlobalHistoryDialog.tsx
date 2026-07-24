/**
 * GlobalHistoryDialog
 *
 * Mounts the HistoryDialog once at the app root. Visibility is controlled by
 * `historyDialogFileAtom` (null = closed, string = file path being viewed).
 * Any entry point can open it by calling `setAtom(filePath)`, with no callback
 * prop drilling required.
 *
 * Restore writes the chosen content to disk; the file watcher then reloads
 * any open editor for that file automatically.
 */

import React, { useCallback } from 'react';
import { useAtom } from 'jotai';
import { historyDialogFileAtom } from '../../store';
import { HistoryDialog } from './HistoryDialog';
import { CollabHistoryDialog } from './CollabHistoryDialog';

interface GlobalHistoryDialogProps {
  theme: string;
  workspacePath?: string;
}

export const GlobalHistoryDialog: React.FC<GlobalHistoryDialogProps> = ({ theme, workspacePath }) => {
  const [filePath, setFilePath] = useAtom(historyDialogFileAtom);

  const handleClose = useCallback(() => {
    setFilePath(null);
  }, [setFilePath]);

  const handleRestore = useCallback(async (content: string) => {
    if (!filePath) return;
    try {
      await window.electronAPI.saveFile(content, filePath);
    } catch (error) {
      console.error('[GlobalHistoryDialog] Failed to restore content:', error);
    }
    setFilePath(null);
  }, [filePath, setFilePath]);

  if (!filePath) return null;

  // Shared documents use a different storage and restore path than local
  // files. Route `collab://` URIs to the dedicated dialog, which talks to
  // the TeamDocumentRoom revision API instead of local PGLite history.
  if (filePath.startsWith('collab://')) {
    return <CollabHistoryDialog collabUri={filePath} onClose={handleClose} />;
  }

  return (
    <HistoryDialog
      isOpen
      onClose={handleClose}
      filePath={filePath}
      onRestore={handleRestore}
      theme={theme}
      workspacePath={workspacePath}
    />
  );
};
