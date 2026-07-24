/**
 * Custom Editor Wrapper
 *
 * Provides runtime protection for custom editor components:
 * - Error boundary to catch render errors
 * - Render loop detection to prevent infinite re-renders
 * - Graceful error display with recovery options
 */

import React, { Component, useRef, useEffect, useState, useCallback } from 'react';
import type { EditorHost } from '@nimbalyst/runtime';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { CustomEditorComponent } from './types';

interface CustomEditorWrapperProps {
  component: CustomEditorComponent;
  host: EditorHost;
  extensionId?: string;
  componentName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

// Configuration for render loop detection
const MAX_RENDERS_PER_SECOND = 60;
const RENDER_WINDOW_MS = 1000;
const RENDER_LOOP_THRESHOLD = MAX_RENDERS_PER_SECOND * 2; // Give some buffer

/**
 * Error Boundary component that catches render errors
 */
class CustomEditorErrorBoundary extends Component<
  { children: React.ReactNode; extensionId?: string; componentName?: string; onReset: () => void },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; extensionId?: string; componentName?: string; onReset: () => void }) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[CustomEditorWrapper] Custom editor crashed:', {
      extensionId: this.props.extensionId,
      componentName: this.props.componentName,
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });

    this.setState({ errorInfo });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset();
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          extensionId={this.props.extensionId}
          componentName={this.props.componentName}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}

/**
 * Error fallback UI component
 */
const ErrorFallback: React.FC<{
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  extensionId?: string;
  componentName?: string;
  onRetry: () => void;
  isRenderLoop?: boolean;
}> = ({ error, errorInfo, extensionId, componentName, onRetry, isRenderLoop }) => {
  return (
    <div className="custom-editor-error flex items-center justify-center h-full p-10 bg-[var(--nim-bg)]">
      <div className="custom-editor-error-content max-w-[500px] text-center">
        <div
          className={`custom-editor-error-icon mb-4 ${isRenderLoop ? 'text-[var(--nim-warning)]' : 'text-[var(--nim-error)]'}`}
        >
          <MaterialSymbol icon={isRenderLoop ? 'loop' : 'error'} size={48} />
        </div>
        <h2 className="m-0 mb-2 text-xl font-semibold text-[var(--nim-text)]">
          {isRenderLoop ? 'Render Loop Detected' : 'Custom Editor Error'}
        </h2>
        {extensionId && (
          <p className="custom-editor-error-extension m-0 mb-4 text-[13px] text-[var(--nim-text-muted)]">
            Extension:{' '}
            <code className="px-1.5 py-0.5 bg-[var(--nim-bg-secondary)] rounded font-mono text-xs">
              {extensionId}
            </code>
            {componentName && (
              <>
                {' '}
                / Component:{' '}
                <code className="px-1.5 py-0.5 bg-[var(--nim-bg-secondary)] rounded font-mono text-xs">
                  {componentName}
                </code>
              </>
            )}
          </p>
        )}
        <p className="custom-editor-error-message m-0 mb-5 text-sm text-[var(--nim-text-muted)] leading-normal">
          {isRenderLoop
            ? 'The custom editor is rendering too rapidly, which may indicate an infinite loop. This has been stopped to prevent freezing.'
            : error?.message || 'An unexpected error occurred while rendering the custom editor.'}
        </p>
        {error?.stack && !isRenderLoop && (
          <details className="custom-editor-error-details m-0 mb-5 text-left">
            <summary className="cursor-pointer text-[13px] text-[var(--nim-text-muted)] py-2 hover:text-[var(--nim-text)]">
              Error Details
            </summary>
            <pre className="mt-2 p-3 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md text-[11px] font-mono text-[var(--nim-text-muted)] overflow-x-auto whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
              {error.stack}
            </pre>
          </details>
        )}
        {isRenderLoop && (
          <div className="custom-editor-error-hint m-0 mb-5 px-4 py-3 bg-[color-mix(in_srgb,var(--nim-warning)_10%,transparent)] border border-[color-mix(in_srgb,var(--nim-warning)_30%,transparent)] rounded-lg text-left">
            <strong className="block mb-2 text-[13px] text-[var(--nim-text)]">
              Common causes:
            </strong>
            <ul className="m-0 pl-5 text-xs text-[var(--nim-text-muted)] leading-relaxed">
              <li>State updates in useEffect without proper dependencies</li>
              <li>Callback props recreated on every render</li>
              <li>Object/array references changing on every render</li>
            </ul>
          </div>
        )}
        <div className="custom-editor-error-actions flex justify-center gap-3">
          <button className="custom-editor-error-retry nim-btn-primary" onClick={onRetry}>
            <MaterialSymbol icon="refresh" size={18} />
            Try Again
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Render loop detection hook
 */
function useRenderLoopDetection(
  extensionId?: string,
  componentName?: string
): { isLooping: boolean; resetLoopDetection: () => void } {
  const renderCountRef = useRef(0);
  const windowStartRef = useRef(Date.now());
  const [isLooping, setIsLooping] = useState(false);

  // Increment render count on each render
  useEffect(() => {
    const now = Date.now();

    // Reset window if it's been too long
    if (now - windowStartRef.current > RENDER_WINDOW_MS) {
      renderCountRef.current = 0;
      windowStartRef.current = now;
    }

    renderCountRef.current++;

    // Check for render loop
    if (renderCountRef.current > RENDER_LOOP_THRESHOLD) {
      console.error('[CustomEditorWrapper] Render loop detected:', {
        extensionId,
        componentName,
        renderCount: renderCountRef.current,
        windowMs: now - windowStartRef.current,
      });
      setIsLooping(true);
    }
  });

  const resetLoopDetection = useCallback(() => {
    renderCountRef.current = 0;
    windowStartRef.current = Date.now();
    setIsLooping(false);
  }, []);

  return { isLooping, resetLoopDetection };
}

/**
 * Custom Editor Wrapper Component
 *
 * Wraps custom editor components with:
 * - Error boundary for catching render errors
 * - Render loop detection to prevent freezing
 * - Graceful error display with recovery options
 *
 * Note: Not memoized to allow re-renders when host properties (like theme) change.
 */
export const CustomEditorWrapper: React.FC<CustomEditorWrapperProps> = ({
  component: CustomEditorComponent,
  host,
  extensionId,
  componentName,
}) => {
  const [resetKey, setResetKey] = useState(0);
  const { isLooping, resetLoopDetection } = useRenderLoopDetection(extensionId, componentName);

  const handleReset = useCallback(() => {
    resetLoopDetection();
    setResetKey((k) => k + 1);
  }, [resetLoopDetection]);

  if (isLooping) {
    return (
      <ErrorFallback
        error={null}
        errorInfo={null}
        extensionId={extensionId}
        componentName={componentName}
        onRetry={handleReset}
        isRenderLoop
      />
    );
  }

  return (
    <div className="custom-editor-wrapper flex-1 w-full h-full min-h-0 overflow-hidden">
      <CustomEditorErrorBoundary
        key={resetKey}
        extensionId={extensionId}
        componentName={componentName}
        onReset={handleReset}
      >
        <CustomEditorComponent host={host} />
      </CustomEditorErrorBoundary>
    </div>
  );
};
