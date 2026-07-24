import { BrowserWindow, dialog, ipcMain } from 'electron';
import { basename, dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { templates } from '../../../../extensions/extension-dev-kit/src/templates.ts';
import { createWindow, findWindowByWorkspace } from '../window/WindowManager';
import {
  addToRecentItems,
  getWorkspaceWindowState,
  isExtensionProjectIntroShown,
  setExtensionProjectIntroShown,
} from '../utils/store';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';

const DEFAULT_EXTENSION_TEMPLATE = 'starter';

function deriveProjectName(projectPath: string): string {
  const raw = basename(projectPath)
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  if (!raw) {
    return 'New Extension';
  }

  return raw
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function deriveExtensionId(projectPath: string): string {
  const slug = basename(projectPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `com.developer.${slug || 'new-extension'}`;
}

function writeTemplateFiles(projectPath: string, files: Record<string, string>): void {
  mkdirSync(projectPath, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = join(projectPath, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf8');
  }
}

function openWorkspace(projectPath: string): void {
  addToRecentItems('workspaces', projectPath, basename(projectPath));

  const existingWindow = findWindowByWorkspace(projectPath);
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.focus();
    return;
  }

  const savedState = getWorkspaceWindowState(projectPath);
  createWindow(false, true, projectPath, savedState?.bounds);
}

interface ExtensionProjectIntroDialogOptions {
  forceShow?: boolean;
  markShown?: boolean;
}

type ExtensionProjectIntroDialogResult = 'continue' | 'dont-show-again' | 'cancel';

async function showExtensionProjectIntroFallbackDialog(
  sourceWindow?: BrowserWindow | null,
): Promise<ExtensionProjectIntroDialogResult> {
  const dialogOptions = {
    type: 'info' as const,
    title: 'Build With Extensions',
    message: 'Extensions can add custom editors, AI tools, panels, commands, and other workspace features.',
    detail: 'Nimbalyst can load your extension project while you build it, so you can test changes inside the app without leaving your development flow.\n\nDescribe what you want to the agent, and watch it build, install, and test the extension right before your eyes.',
    buttons: ['Cancel', "Don't Show Again", 'Continue'],
    defaultId: 2,
    cancelId: 0,
    noLink: true,
  };

  const result = sourceWindow
    ? await dialog.showMessageBox(sourceWindow, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);

  switch (result.response) {
    case 1:
      return 'dont-show-again';
    case 2:
      return 'continue';
    default:
      return 'cancel';
  }
}

export async function showExtensionProjectIntroDialog(
  sourceWindow?: BrowserWindow | null,
  options: ExtensionProjectIntroDialogOptions = {},
): Promise<boolean> {
  const { forceShow = false, markShown = true } = options;

  console.log('[ExtensionProjectScaffolder] showExtensionProjectIntroDialog called, forceShow:', forceShow, 'isShown:', isExtensionProjectIntroShown());

  if (!forceShow && isExtensionProjectIntroShown()) {
    console.log('[ExtensionProjectScaffolder] Intro already shown, skipping');
    return true;
  }

  let result: ExtensionProjectIntroDialogResult;

  if (sourceWindow && !sourceWindow.isDestroyed()) {
    result = await new Promise<ExtensionProjectIntroDialogResult>((resolve) => {
      const requestId = `extension-project-intro-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const channel = `extension-project-intro-dialog-response:${requestId}`;
      console.log('[ExtensionProjectScaffolder] Sending IPC to renderer, channel:', channel);
      const timeout = setTimeout(async () => {
        console.log('[ExtensionProjectScaffolder] Timeout reached, falling back to native dialog');
        ipcMain.removeAllListeners(channel);
        resolve(await showExtensionProjectIntroFallbackDialog(sourceWindow));
      }, 15000);

      ipcMain.once(channel, (_event, data: { action?: ExtensionProjectIntroDialogResult } | undefined) => {
        clearTimeout(timeout);
        console.log('[ExtensionProjectScaffolder] Received response:', data?.action);
        resolve(data?.action ?? 'cancel');
      });

      sourceWindow.webContents.send('show-extension-project-intro-dialog', { requestId });
    });
  } else {
    console.log('[ExtensionProjectScaffolder] No source window, using fallback dialog');
    result = await showExtensionProjectIntroFallbackDialog(sourceWindow);
  }

  console.log('[ExtensionProjectScaffolder] Dialog result:', result);

  if (result === 'cancel') {
    return false;
  }

  if (markShown) {
    setExtensionProjectIntroShown(true);
  }

  return true;
}

export async function showNewExtensionProjectDialog(sourceWindow?: BrowserWindow | null): Promise<void> {
  console.log('[ExtensionProjectScaffolder] showNewExtensionProjectDialog called, sourceWindow:', !!sourceWindow);
  const shouldContinue = await showExtensionProjectIntroDialog(sourceWindow);
  console.log('[ExtensionProjectScaffolder] shouldContinue:', shouldContinue);
  if (!shouldContinue) {
    return;
  }

  // Deliberately window-less: a new extension project is a sibling of the
  // user's projects, not content inside the currently-open workspace, so this
  // starts from the last-used directory rather than the active project.
  const defaultPath = getDialogDefaultPath({
    suggestedName: 'my-nimbalyst-extension',
  });
  const projectResult = sourceWindow
    ? await dialog.showSaveDialog(sourceWindow, {
      title: 'Create New Extension Project',
      defaultPath,
      buttonLabel: 'Create Project',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    : await dialog.showSaveDialog({
      title: 'Create New Extension Project',
      defaultPath,
      buttonLabel: 'Create Project',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });

  if (projectResult.canceled || !projectResult.filePath) {
    return;
  }

  rememberDialogSelection(projectResult.filePath, 'file');

  const projectPath = projectResult.filePath;

  if (existsSync(projectPath) && readdirSync(projectPath).length > 0) {
    if (sourceWindow) {
      await dialog.showMessageBox(sourceWindow, {
        type: 'warning',
        title: 'Folder Not Empty',
        message: 'Choose an empty folder for the new extension project.',
        detail: `The selected folder already contains files:\n${projectPath}`,
        buttons: ['OK'],
      });
    } else {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Folder Not Empty',
        message: 'Choose an empty folder for the new extension project.',
        detail: `The selected folder already contains files:\n${projectPath}`,
        buttons: ['OK'],
      });
    }
    return;
  }

  const templateFn = templates[DEFAULT_EXTENSION_TEMPLATE];
  const files = templateFn({
    name: deriveProjectName(projectPath),
    extensionId: deriveExtensionId(projectPath),
    filePatterns: ['*.example'],
  });

  writeTemplateFiles(projectPath, files);
  openWorkspace(projectPath);
}
