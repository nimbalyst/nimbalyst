/**
 * Panel Host Implementation
 *
 * Creates PanelHost instances for extension panels.
 * Handles communication between panels and the host application.
 */

import type { ComponentType } from 'react';
import { createElement } from 'react';
import type { PanelHost, PanelAIContext, ExtensionStorage, ExtensionFileStorage, ExtensionDataAccess, ExecOptions, ExecResult } from '@nimbalyst/runtime';
import type { PanelHostComponents, PanelPanes, PanelPaneSide, PanelSessionTranscriptProps } from '@nimbalyst/extension-sdk';
import { store } from '@nimbalyst/runtime/store';
import { ExtensionFileStorageImpl } from './ExtensionFileStorageImpl';
import { setPanelGutterBadge } from './panelGutterBadges';
import { addPanelPaneToggleHandler, setPanelPanes } from './panelPanes';
import { workspaceRootPathsAtom } from '../../store/atoms/fileTree';
import { isPathInWorkspace } from '../../../shared/pathUtils';

// ============================================================================
// Types
// ============================================================================

export interface PanelHostOptions {
  panelId: string;
  extensionId: string;
  theme: string;
  workspacePath: string;
  aiSupported: boolean;
  storage: ExtensionStorage;

  // Callbacks
  onOpenFile: (path: string) => void;
  onOpenPanel: (panelId: string) => void;
  onClose: () => void;
  onThemeChange: (callback: (theme: string) => void) => () => void;

  /**
   * Host transcript component, passed only when the extension may see agent
   * sessions (manifest `permissions.ai`). Injected rather than imported so this
   * module stays free of the transcript's import graph.
   */
  sessionTranscript?: ComponentType<SessionTranscriptBindings & PanelSessionTranscriptProps>;
}

interface SessionTranscriptBindings {
  workspacePath: string;
  onOpenFile: (path: string) => void;
}

/** Bind the host's workspace and file-open path so the panel passes only a session id. */
function createPanelHostComponents(
  Transcript: ComponentType<SessionTranscriptBindings & PanelSessionTranscriptProps>,
  bindings: SessionTranscriptBindings,
): PanelHostComponents {
  const SessionTranscript = (props: PanelSessionTranscriptProps) =>
    createElement(Transcript, { ...props, ...bindings });
  SessionTranscript.displayName = 'PanelHost.SessionTranscript';
  return { SessionTranscript };
}

// ============================================================================
// AI Context Implementation
// ============================================================================

class PanelAIContextImpl implements PanelAIContext {
  private context: Record<string, unknown> = {};
  private listeners = new Set<(context: Record<string, unknown>) => void>();

  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
    this.notifyListeners();
  }

  getContext(): Record<string, unknown> {
    return { ...this.context };
  }

  clearContext(): void {
    this.context = {};
    this.notifyListeners();
  }

  notifyChange(event: string, data?: unknown): void {
    // Could be used for proactive AI suggestions in the future
    console.log(`[PanelAIContext] Event: ${event}`, data);
  }

  onContextChanged(callback: (context: Record<string, unknown>) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.getContext());
      } catch (error) {
        console.error('[PanelAIContext] Error in listener:', error);
      }
    }
  }
}

// ============================================================================
// Data Access Implementation
// ============================================================================

function createExtensionDataAccess(extensionId: string): ExtensionDataAccess {
  return {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await window.electronAPI.invoke('extension:database:query', {
        extensionId,
        sql,
        params,
      });
      return (result as { rows: T[] }).rows;
    },
  };
}

// ============================================================================
// Panel Host Implementation
// ============================================================================

class PanelHostImpl implements PanelHost {
  readonly panelId: string;
  readonly extensionId: string;
  readonly workspacePath: string;
  readonly ai?: PanelAIContext;
  readonly storage: ExtensionStorage;
  readonly files: ExtensionFileStorage;
  readonly data: ExtensionDataAccess;
  readonly components?: PanelHostComponents;

  private _theme: string;
  private _isSettingsOpen = false;
  private themeListeners = new Set<(theme: string) => void>();
  private eventCleanups: (() => void)[] = [];

  private onOpenFile: (path: string) => void;
  private onOpenPanel: (panelId: string) => void;
  private onClosePanel: () => void;
  private unsubscribeTheme: () => void;

  constructor(options: PanelHostOptions) {
    this.panelId = options.panelId;
    this.extensionId = options.extensionId;
    this._theme = options.theme;
    this.workspacePath = options.workspacePath;
    this.storage = options.storage;
    this.files = new ExtensionFileStorageImpl(options.extensionId, options.workspacePath);
    this.data = createExtensionDataAccess(options.extensionId);

    this.onOpenFile = options.onOpenFile;
    this.onOpenPanel = options.onOpenPanel;
    this.onClosePanel = options.onClose;

    // Subscribe to theme changes
    this.unsubscribeTheme = options.onThemeChange((theme) => {
      this._theme = theme;
      this.notifyThemeChange(theme);
    });

    // Create AI context if supported
    if (options.aiSupported) {
      this.ai = new PanelAIContextImpl();
    }

    if (options.sessionTranscript) {
      this.components = createPanelHostComponents(options.sessionTranscript, {
        workspacePath: options.workspacePath,
        onOpenFile: (path) => this.onOpenFile(path),
      });
    }
  }

  get theme(): string {
    return this._theme;
  }

  /**
   * Every root of the workspace, primary first. Read live from the atom the
   * explorer already maintains rather than captured at construction, so a
   * panel open across an attach or detach sees the current set.
   *
   * Falls back to the primary root alone before the explorer has published --
   * a panel that mounts early gets the single-folder answer, never an empty
   * list it would have to special-case.
   */
  getWorkspaceFolders(): string[] {
    const roots = store.get(workspaceRootPathsAtom);
    return roots.length > 0 && roots[0] === this.workspacePath ? roots : [this.workspacePath];
  }

  getPrimaryFolderPath(): string {
    return this.workspacePath;
  }

  get isSettingsOpen(): boolean {
    return this._isSettingsOpen;
  }

  onThemeChanged(callback: (theme: string) => void): () => void {
    this.themeListeners.add(callback);
    return () => {
      this.themeListeners.delete(callback);
    };
  }

  openFile(path: string): void {
    this.onOpenFile(path);
  }

  openPanel(panelId: string): void {
    this.onOpenPanel(panelId);
  }

  close(): void {
    this.onClosePanel();
  }

  openSettings(): void {
    this._isSettingsOpen = true;
  }

  closeSettings(): void {
    this._isSettingsOpen = false;
  }

  onWorkspaceEvent(event: string, callback: (data: unknown) => void): () => void {
    const unsub = window.electronAPI.on(event, (data: unknown) => {
      // Filter to events for this workspace. Watchers are registered per repo,
      // so a repo inside an attached folder names itself rather than the
      // primary root -- match against every root or those events are dropped
      // and the panel never refreshes for the attached repo.
      const d = data as Record<string, unknown> | undefined;
      const eventPath = d?.workspacePath;
      if (typeof eventPath === 'string' && eventPath) {
        const roots = this.getWorkspaceFolders();
        if (!roots.some((root) => isPathInWorkspace(eventPath, root))) return;
      }
      callback(data);
    });
    this.eventCleanups.push(unsub);
    return () => {
      unsub();
      this.eventCleanups = this.eventCleanups.filter(c => c !== unsub);
    };
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    try {
      const result = await window.electronAPI.invoke('extension:exec', {
        extensionId: this.extensionId,
        command,
        cwd: options?.cwd || this.workspacePath,
        timeout: options?.timeout || 60000,
        env: options?.env,
        maxBuffer: options?.maxBuffer || 10 * 1024 * 1024,
      });
      return result as ExecResult;
    } catch (error) {
      return {
        success: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
      };
    }
  }

  callBackendTool(toolName: string, args?: Record<string, unknown>): Promise<unknown> {
    // callerExtensionId comes from the host, never from panel code: main uses
    // it to refuse tools that another extension's backend module registered.
    return window.electronAPI.invoke('extensions:ai-call-backend-tool', {
      toolName,
      args: args ?? {},
      workspacePath: this.workspacePath,
      callerExtensionId: this.extensionId,
    });
  }

  setGutterBadge(value: number | null, options?: { tone?: 'default' | 'warning' }): void {
    // Deliberately not cleared in dispose(): the badge must outlive the panel.
    setPanelGutterBadge(this.panelId, value, options?.tone ?? 'default');
  }

  setPanes(panes: PanelPanes | null): void {
    setPanelPanes(this.panelId, panes);
  }

  onPaneToggle(callback: (side: PanelPaneSide) => void): () => void {
    return addPanelPaneToggleHandler(this.panelId, callback);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.unsubscribeTheme();
    this.themeListeners.clear();
    for (const cleanup of this.eventCleanups) cleanup();
    this.eventCleanups = [];
  }

  private notifyThemeChange(theme: string): void {
    for (const listener of this.themeListeners) {
      try {
        listener(theme);
      } catch (error) {
        console.error('[PanelHost] Error in theme listener:', error);
      }
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a PanelHost instance for a panel.
 */
export function createPanelHost(options: PanelHostOptions): PanelHost {
  return new PanelHostImpl(options);
}
