/**
 * Mobile Lexical Editor for WKWebView
 *
 * Standalone React app that provides a full Lexical markdown editor
 * inside WKWebView on iOS. Communicates with Swift via the editorBridge.
 *
 * Bridge API:
 *   JS -> Swift: webkit.messageHandlers.editorBridge.postMessage({ type, ... })
 *     - editorReady: editor mounted and ready
 *     - contentChanged: markdown content changed (debounced 500ms)
 *     - dirty: editor has unsaved changes
 *     - error: JS error occurred
 *
 *   Swift -> JS: window.nimbalystEditor.*
 *     - loadMarkdown(content: string): load markdown into editor
 *     - setReadOnly(readonly: boolean): toggle read-only mode
 *     - getContent(): string: get current markdown content
 *     - formatText(format: string): apply text format (bold, italic, underline, strikethrough, code)
 *
 * CRITICAL: All hooks must come BEFORE any early returns.
 * WKWebView swallows JS errors silently -- a hooks violation
 * will blank the screen with no diagnostic output.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';

// Deep import the editor to avoid pulling in the entire runtime barrel
// (which transitively imports Excalidraw, Mermaid, etc. = ~25MB).
// The editor barrel registers built-in plugins and imports editor CSS.
import {
  NimbalystEditor,
  type EditorConfig,
  $convertToEnhancedMarkdownString,
  $convertFromEnhancedMarkdownString,
  getEditorTransformers,
} from '@nimbalyst/runtime/editor';

import { $getRoot, FORMAT_TEXT_COMMAND } from 'lexical';
import type { LexicalEditor, TextFormatType } from 'lexical';

import './styles.css';

// ============================================================================
// Bridge helpers
// ============================================================================

function postToNative(message: Record<string, unknown>): void {
  try {
    (window as any).webkit?.messageHandlers?.editorBridge?.postMessage(message);
  } catch {
    // Bridge may not be available (e.g., dev mode in browser)
  }
}

function postErrorToNative(error: Error | string, context?: string): void {
  const msg = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : '';
  postToNative({
    type: 'error',
    message: context ? `${context}: ${msg}` : msg,
    stack: stack ?? '',
  });
}

function isBenignWindowErrorMessage(message: string): boolean {
  return message === 'ResizeObserver loop completed with undelivered notifications.';
}

// Global error handler
window.onerror = (message, _source, _lineno, _colno, error) => {
  const normalizedMessage = error instanceof Error ? error.message : String(message);
  if (isBenignWindowErrorMessage(normalizedMessage)) {
    return true;
  }
  postErrorToNative(error ?? String(message), 'window.onerror');
  return false;
};

window.onunhandledrejection = (event) => {
  const reason =
    event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (isBenignWindowErrorMessage(reason)) {
    event.preventDefault();
    return;
  }
  postErrorToNative(
    event.reason instanceof Error ? event.reason : String(event.reason),
    'unhandledrejection'
  );
};

// ============================================================================
// Error Boundary
// ============================================================================

class EditorErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    postErrorToNative(error, 'React render error');
    console.error('[EditorErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: '#ef4444', fontFamily: 'system-ui' }}>
          <h3>Editor Error</h3>
          <p>{this.state.error?.message ?? 'Unknown error'}</p>
          <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: '#999' }}>
            {this.state.error?.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================
// Editor App
// ============================================================================

function EditorApp(): React.ReactElement {
  // -- All hooks BEFORE any early return --
  const [content, setContent] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const editorRef = useRef<LexicalEditor | null>(null);
  const getContentRef = useRef<(() => string) | null>(null);
  const contentChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced content change notification to Swift
  const notifyContentChanged = useCallback((markdown: string) => {
    if (contentChangeTimerRef.current) {
      clearTimeout(contentChangeTimerRef.current);
    }
    contentChangeTimerRef.current = setTimeout(() => {
      postToNative({ type: 'contentChanged', content: markdown });
    }, 500);
  }, []);

  // Set up the Swift -> JS bridge
  useEffect(() => {
    const bridge = {
      loadMarkdown: (markdown: string) => {
        try {
          const editor = editorRef.current;
          if (editor) {
            // Editor already mounted -- update content
            editor.update(() => {
              const root = $getRoot();
              root.clear();
              $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
            });
          } else {
            // Editor not yet mounted -- set initial content
            setContent(markdown);
          }
        } catch (err) {
          postErrorToNative(err instanceof Error ? err : new Error(String(err)), 'loadMarkdown');
        }
      },

      setReadOnly: (isReadOnly: boolean) => {
        setReadOnly(isReadOnly);
      },

      getContent: (): string => {
        if (getContentRef.current) {
          return getContentRef.current();
        }
        return '';
      },

      formatText: (format: TextFormatType) => {
        const editor = editorRef.current;
        if (editor) {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
        }
      },
    };

    (window as any).nimbalystEditor = bridge;

    // Signal readiness
    postToNative({ type: 'editorReady' });

    return () => {
      delete (window as any).nimbalystEditor;
    };
  }, []); // Empty deps -- runs once on mount

  // Handle dirty state changes
  const handleDirtyChange = useCallback((isDirty: boolean) => {
    postToNative({ type: 'dirty', isDirty });
  }, []);

  // Handle getContent callback from NimbalystEditor
  const handleGetContent = useCallback((fn: () => string) => {
    getContentRef.current = fn;
  }, []);

  // Handle editor ready
  const handleEditorReady = useCallback((editor: LexicalEditor) => {
    editorRef.current = editor;

    // Listen for content changes to notify Swift
    editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      // Skip updates with no actual changes
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

      editorState.read(() => {
        const markdown = $convertToEnhancedMarkdownString(getEditorTransformers());
        notifyContentChanged(markdown);
      });
    });
  }, [notifyContentChanged]);

  // Build editor config
  const editorConfig: EditorConfig = {
    editable: !readOnly,
    showToolbar: false,
    initialContent: content ?? undefined,
    onDirtyChange: handleDirtyChange,
    onGetContent: handleGetContent,
    onEditorReady: handleEditorReady,
  };

  // Show placeholder until Swift calls loadMarkdown
  if (content === null) {
    return (
      <div className="editor-loading">
        <span>Waiting for content...</span>
      </div>
    );
  }

  return (
    <div className="mobile-editor">
      <NimbalystEditor config={editorConfig} />
    </div>
  );
}

// ============================================================================
// Mount
// ============================================================================

const root = document.getElementById('editor-root');
if (root) {
  ReactDOM.createRoot(root).render(
    <EditorErrorBoundary>
      <EditorApp />
    </EditorErrorBoundary>
  );
} else {
  postErrorToNative(new Error('editor-root element not found'), 'mount');
}
