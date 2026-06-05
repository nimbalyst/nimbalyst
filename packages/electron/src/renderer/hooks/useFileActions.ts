/**
 * useFileActions - Shared hook for common file operations.
 *
 * Consolidates actions that appear across multiple context menus
 * (file tree, tab bar, editor header) into a single reusable hook.
 */

import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  hasExternalEditorAtom,
  externalEditorNameAtom,
  openInExternalEditorAtom,
  revealInFinderAtom,
  copyFilePathAtom,
} from '../store/atoms/appSettings';
import { dialogRef, DIALOG_IDS } from '../dialogs';
import type { ShareDialogData } from '../dialogs';
/**
 * File extensions that support sharing via link.
 * Markdown files are rendered to static HTML on the desktop before upload.
 * Extension file types are uploaded as raw content and rendered by the web extension viewer.
 *
 * This must stay in sync with FILE_EXTENSION_TO_VIEWER_TYPE in ShareHandlers.ts
 * and EXTENSION_VIEWER_ALLOWLIST in collabv3/src/share.ts.
 */
const SHAREABLE_EXTENSIONS = new Set([
  '.md', '.markdown',  // Static HTML rendering
  '.mindmap',          // Extension viewer: Mindmap
  '.prisma',           // Extension viewer: DataModelLM
  '.excalidraw',       // Extension viewer: Excalidraw
  '.csv', '.tsv',      // Extension viewer: CSV Spreadsheet
]);

/** Compound suffixes that need full-name matching (e.g. .mockup.html). */
const SHAREABLE_SUFFIXES = ['.mockup.html', '.calc.md', '.slides.md'];

function isShareableFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (SHAREABLE_SUFFIXES.some(s => lower.endsWith(s))) return true;
  const ext = lower.lastIndexOf('.') >= 0
    ? lower.slice(lower.lastIndexOf('.'))
    : '';
  return SHAREABLE_EXTENSIONS.has(ext);
}

export interface FileActions {
  hasExternalEditor: boolean;
  externalEditorName: string | undefined;
  isShareable: boolean;

  openInDefaultApp: () => Promise<void>;
  openInExternalEditor: () => void;
  revealInFinder: () => void;
  copyFilePath: () => void;
  shareLink: () => void;
}

export function useFileActions(filePath: string, fileName: string): FileActions {
  const hasExtEditor = useAtomValue(hasExternalEditorAtom);
  const extEditorName = useAtomValue(externalEditorNameAtom);
  const openInExtEditor = useSetAtom(openInExternalEditorAtom);
  const revealInFinderAction = useSetAtom(revealInFinderAtom);
  const copyFilePathAction = useSetAtom(copyFilePathAtom);

  const isShareable = isShareableFile(fileName);

  const openInDefaultApp = useCallback(async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      const result = await window.electronAPI.openInDefaultApp(filePath);
      if (!result.success) {
        console.error('Failed to open in default app:', result.error);
      }
    }
  }, [filePath]);

  const openInExternalEditor = useCallback(() => {
    openInExtEditor(filePath);
  }, [openInExtEditor, filePath]);

  const revealInFinder = useCallback(() => {
    revealInFinderAction(filePath);
  }, [revealInFinderAction, filePath]);

  const copyFilePath = useCallback(() => {
    copyFilePathAction(filePath);
  }, [copyFilePathAction, filePath]);

  const shareLink = useCallback(() => {
    dialogRef.current?.open<ShareDialogData>(DIALOG_IDS.SHARE, {
      contentType: 'file',
      filePath,
      title: fileName,
    });
  }, [filePath, fileName]);

  return {
    hasExternalEditor: hasExtEditor,
    externalEditorName: extEditorName,
    isShareable,
    openInDefaultApp,
    openInExternalEditor,
    revealInFinder,
    copyFilePath,
    shareLink,
  };
}
