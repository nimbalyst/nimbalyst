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

export function PanelContainer({
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

  // Create PanelHost
  const host = useMemo(() => {
    const options: PanelHostOptions = {
      panelId: panel.id,
      extensionId: panel.extensionId,
      theme: resolvedTheme,
      workspacePath,
      aiSupported: panel.aiSupported,
      storage,
      onOpenFile,
      onOpenPanel,
      onClose,
      onThemeChange,
    };

    return createPanelHost(options);
  }, [panel.id, panel.extensionId, panel.aiSupported, workspacePath, storage, onOpenFile, onOpenPanel, onClose, onThemeChange, resolvedTheme]);

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

  return (
    <div className="panel-container flex flex-col h-full w-full overflow-hidden" data-panel-id={panel.id} data-extension-id={panel.extensionId} data-theme={theme}>
      <PanelErrorBoundary panelId={panel.id}>
        {/* Key forces a fresh remount when the workspace switches so panels
            (e.g. the git extension) re-read all per-workspace data instead
            of holding state captured for the previous project. */}
        <PanelComponent key={workspacePath} host={host} />
      </PanelErrorBoundary>
    </div>
  );
}
