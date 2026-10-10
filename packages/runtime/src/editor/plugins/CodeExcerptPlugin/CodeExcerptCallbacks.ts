/**
 * Host slot for the code excerpt block's repo access. With nothing registered
 * the block falls back to the Electron IPC channels when they exist, and
 * otherwise shows the stored snapshot without a drift badge (web console,
 * mobile, a machine without the repo).
 */

export interface CodeExcerptFile {
  /**
   * The file's text at HEAD, or null when it is not committed (missing,
   * untracked, ignored) or refused. Never the working tree.
   */
  text: string | null;
  /** Why the host would not read this path (e.g. a dotfile). */
  refused?: string;
  /** Short HEAD commit, or null outside git. */
  head: string | null;
  absolutePath: string;
}

export interface CodeExcerptCallbacks {
  readExcerptFile?: (relativePath: string) => Promise<CodeExcerptFile | null>;
  openFileAtLine?: (absolutePath: string, line: number) => void;
}

let callbacks: CodeExcerptCallbacks = {};

export function getCodeExcerptCallbacks(): CodeExcerptCallbacks {
  return callbacks;
}

export function setCodeExcerptCallbacks(next: CodeExcerptCallbacks): void {
  callbacks = next;
}

interface ElectronInvoke {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

function electronHost(): { api: ElectronInvoke; workspacePath: string } | null {
  const win = window as unknown as { electronAPI?: ElectronInvoke; __workspacePath?: string };
  return win.electronAPI && win.__workspacePath ? { api: win.electronAPI, workspacePath: win.__workspacePath } : null;
}

export function readExcerptFile(relativePath: string): Promise<CodeExcerptFile | null> {
  const host = callbacks.readExcerptFile;
  if (host) return host(relativePath).catch(() => null);
  const electron = electronHost();
  if (!electron) return Promise.resolve(null);
  return (electron.api.invoke('code-excerpt:read', { workspacePath: electron.workspacePath, path: relativePath }) as Promise<CodeExcerptFile>)
    .catch(() => null);
}

export function openExcerptFile(absolutePath: string, line: number): void {
  if (callbacks.openFileAtLine) {
    callbacks.openFileAtLine(absolutePath, line);
    return;
  }
  // Without a host opener the file opens at the top.
  const electron = electronHost();
  void electron?.api.invoke('workspace:open-file', { workspacePath: electron.workspacePath, filePath: absolutePath });
}

/** Workspace-relative form of a path the user typed or pasted. */
export function toWorkspaceRelative(path: string): string {
  const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath;
  const trimmed = path.trim().replace(/^\.\//, '');
  if (workspacePath && trimmed.startsWith(`${workspacePath.replace(/\/$/, '')}/`)) {
    return trimmed.slice(workspacePath.replace(/\/$/, '').length + 1);
  }
  return trimmed;
}
