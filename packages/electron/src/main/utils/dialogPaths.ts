import { app, type BrowserWindow } from 'electron';
import { statSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { store } from './store';
import { getWindowIdForWindow, resolveActiveWorkspacePathForWindowId } from '../window/windowState';

type SelectionKind = 'file' | 'directory';

export interface DialogPathOptions {
  window?: BrowserWindow | null;
  explicitPath?: string;
  suggestedName?: string;
}

interface DialogPathInputs {
  explicitPath?: string;
  workspacePath?: string | null;
  lastDirectory?: string;
  documentsPath: string;
  suggestedName?: string;
}

export function selectDialogDefaultPath(inputs: DialogPathInputs): string {
  const basePath = inputs.workspacePath || inputs.lastDirectory || inputs.documentsPath;
  if (inputs.explicitPath) {
    return isAbsolute(inputs.explicitPath)
      ? inputs.explicitPath
      : join(basePath, inputs.explicitPath);
  }
  return inputs.suggestedName ? join(basePath, inputs.suggestedName) : basePath;
}

export function selectedDialogDirectory(selectedPath: string, kind: SelectionKind): string {
  return kind === 'directory' ? selectedPath : dirname(selectedPath);
}

function workspacePathForWindow(window?: BrowserWindow | null): string | null {
  return resolveActiveWorkspacePathForWindowId(getWindowIdForWindow(window)) ?? null;
}

/**
 * A remembered or workspace directory is only usable if it still exists — a
 * project moved to another disk, a deleted folder, or an unmounted volume
 * would otherwise be handed to the native dialog, which degrades differently
 * on each platform. Fall through to the next candidate instead.
 */
export function usableDirectory(candidate: string | null | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Default location for a native file/folder dialog.
 *
 * Electron 43 defaults pickers to the Downloads folder, which is almost never
 * where the user is working. Prefer, in order: the window's active workspace,
 * the last directory a dialog landed in, then Documents.
 *
 * Pass `window` whenever the dialog concerns workspace content, so it opens in
 * the project the user is actually looking at. Omit it only for dialogs that
 * are deliberately workspace-independent — picking a notification sound, or
 * choosing where a brand-new project should live.
 */
export function getDialogDefaultPath(options: DialogPathOptions = {}): string {
  return selectDialogDefaultPath({
    explicitPath: options.explicitPath,
    workspacePath: usableDirectory(workspacePathForWindow(options.window)) ?? null,
    lastDirectory: usableDirectory(store.get('lastDialogDirectory')),
    documentsPath: app.getPath('documents'),
    suggestedName: options.suggestedName,
  });
}

export function rememberDialogSelection(selectedPath: string | undefined, kind: SelectionKind): void {
  if (!selectedPath) return;
  store.set('lastDialogDirectory', selectedDialogDirectory(selectedPath, kind));
}
