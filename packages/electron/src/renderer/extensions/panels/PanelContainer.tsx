/**
 * Panel Container
 *
 * Renders an extension panel with its PanelHost.
 * Handles error boundaries and loading states.
 */

import type { JSX } from 'react';
import React, { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { useTheme } from '../../hooks/useTheme';
import { createExtensionStorage } from '@nimbalyst/runtime';
import { createPanelHost, type PanelHostOptions } from './PanelHostImpl';
import type { RegisteredPanel } from './PanelRegistry';
import { setExtensionPanelAIContextAtom } from '../../store/atoms/extensionPanels';

// ============================================================================
// Types
// ============================================================================

interface PanelContainerProps {
  panel: RegisteredPanel;
  workspacePath: string;
  onOpenFile: (path: string) => void;
  onOpenPanel: (panelId: string) => void;
  onClose: () => void;
}

// ============================================================================
// Error Boundary
// ============================================================================

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class PanelErrorBoundary extends React.Component<
  { panelId: string; children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { panelId: string; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(`[PanelContainer] Error in panel ${this.props.panelId}:`, error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="panel-error flex flex-col items-center justify-center h-full p-8 text-center gap-3">
          <span className="material-symbols-outlined panel-error-icon text-5xl text-[var(--nim-error)]">error</span>
          <div className="panel-error-title text-base font-semibold text-[var(--nim-text)]">Panel Error</div>
          <div className="panel-error-message text-[13px] text-[var(--nim-text-muted)] max-w-[300px] break-words">
            {this.state.error?.message || 'An unknown error occurred'}
          </div>
          <button
            className="panel-error-retry mt-2 px-4 py-2 border border-[var(--nim-border)] rounded bg-transparent text-[var(--nim-text)] text-[13px] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
            onClick={() => this.setState({ hasError: false, error: undefined })}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// ============================================================================
// Panel Container Component
// ============================================================================

/**
 * Everything that builds and wires the host lives here, one level below the
 * error boundary, so a failure in the wiring is contained the same way a
 * failure in the panel itself is. An error boundary cannot catch a throw from
 * its own parent's hooks, so while this ran in the exported component a bad
 * host escaped to the app-level boundary and blanked the entire window.
 */
function PanelContainerInner({
  panel,
  workspacePath,
  onOpenFile,
  onOpenPanel,
  onClose,
}: PanelContainerProps): JSX.Element {
  // Get the resolved theme (extension themes are resolved to 'light' or 'dark')
  const { theme } = useTheme();
  const [themeListeners] = useState(() => new Set<(theme: string) => void>());
  const setExtensionPanelAIContext = useSetAtom(setExtensionPanelAIContextAtom);

  // Resolve theme to effective value (never 'auto' at runtime)
  const resolvedTheme = (theme === 'auto' ? 'light' : theme) as string;

  // Notify theme listeners when theme changes
  useEffect(() => {
    for (const listener of themeListeners) {
      listener(resolvedTheme);
    }
  }, [resolvedTheme, themeListeners]);

  // Create stable theme subscription function
  const onThemeChange = useCallback((callback: (theme: string) => void) => {
    themeListeners.add(callback);
    return () => {
      themeListeners.delete(callback);
    };
  }, [themeListeners]);

  // Create extension storage (memoized by extensionId)
  const storage = useMemo(() => {
    return createExtensionStorage(panel.extensionId);
  }, [panel.extensionId]);

  // The host is a service object handed to third-party panel code, and its
  // identity drives the AI-context effect below, so it must survive a parent
  // re-render. App.tsx passes inline arrows for onOpenPanel/onClose, so keeping
  // the raw callbacks in the memo deps rebuilt the host on every App render;
  // that re-ran the effect below, which wrote the atom App subscribes to, which
  // re-rendered App — an unbounded loop allocating a host per turn. It runs in
  // this component rather than the panel, so PanelErrorBoundary never sees it
  // and the whole window goes down with the renderer.
  const latestCallbacks = useRef({ onOpenFile, onOpenPanel, onClose });
  latestCallbacks.current = { onOpenFile, onOpenPanel, onClose };

  const openFile = useCallback((path: string) => latestCallbacks.current.onOpenFile(path), []);
  const openPanel = useCallback((panelId: string) => latestCallbacks.current.onOpenPanel(panelId), []);
  const closePanel = useCallback(() => latestCallbacks.current.onClose(), []);

  // Seed only: later theme changes reach the host through onThemeChange, so the
  // current theme must not rebuild it either.
  const initialTheme = useRef(resolvedTheme);
  initialTheme.current = resolvedTheme;

  // Create PanelHost
  const host = useMemo(() => {
    const options: PanelHostOptions = {
      panelId: panel.id,
      extensionId: panel.extensionId,
      theme: initialTheme.current,
      workspacePath,
      aiSupported: panel.aiSupported,
      storage,
      onOpenFile: openFile,
      onOpenPanel: openPanel,
      onClose: closePanel,
      onThemeChange,
    };

    return createPanelHost(options);
  }, [panel.id, panel.extensionId, panel.aiSupported, workspacePath, storage, openFile, openPanel, closePanel, onThemeChange]);

  // Subscribe to AI context changes and sync to atom
  useEffect(() => {
    if (!panel.aiSupported || !host.ai) {
      return;
    }

    // Set initial context
    const initialContext = host.ai.getContext();
    setExtensionPanelAIContext({
      panelId: panel.id,
      extensionId: panel.extensionId,
      panelTitle: panel.title,
      context: initialContext,
    });

    // Subscribe to updates
    const unsubscribe = host.ai.onContextChanged((context) => {
      setExtensionPanelAIContext({
        panelId: panel.id,
        extensionId: panel.extensionId,
        panelTitle: panel.title,
        context,
      });
    });

    // Clear context when unmounting
    return () => {
      unsubscribe();
      setExtensionPanelAIContext(null);
    };
  }, [host, panel.id, panel.extensionId, panel.title, panel.aiSupported, setExtensionPanelAIContext]);

  const PanelComponent = panel.component;

  /* Key forces a fresh remount when the workspace switches so panels
     (e.g. the git extension) re-read all per-workspace data instead
     of holding state captured for the previous project. */
  return <PanelComponent key={workspacePath} host={host} />;
}

/**
 * Owns only the frame and the boundary, so an extension panel can never take
 * the window down: everything that can realistically throw (host construction,
 * storage, the AI-context effect, the panel itself) renders beneath the
 * boundary.
 */
export function PanelContainer(props: PanelContainerProps): JSX.Element {
  const { theme } = useTheme();

  return (
    <div
      className="panel-container flex flex-col h-full w-full overflow-hidden"
      data-panel-id={props.panel.id}
      data-extension-id={props.panel.extensionId}
      data-theme={theme}
    >
      <PanelErrorBoundary panelId={props.panel.id}>
        <PanelContainerInner {...props} />
      </PanelErrorBoundary>
    </div>
  );
}
