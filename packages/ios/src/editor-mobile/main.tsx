/**
 * Mobile Lexical Editor for WKWebView
 *
 * Standalone React app that provides a full Lexical markdown editor
 * inside WKWebView on iOS. Communicates with Swift via the editorBridge.
 *
 * Bridge API:
 *   JS -> Swift: webkit.messageHandlers.editorBridge.postMessage({ type, ... })
 *     - editorReady: editor mounted and ready
 *     - contentChanged: { content, revision } to persist (debounced 500ms); native
 *       answers saveResult(revision, ok)
 *     - dirty: whether the editor differs from what native confirmed, or a save is in flight
 *     - linkClicked: a link was tapped ({ href, title }); native decides where it goes
 *     - error: JS error occurred
 *
 *   Only the body goes through Lexical. The frontmatter text is kept as loaded
 *   and re-attached on every save (see frontmatter.ts), and a load never
 *   reports a content change, so opening or refreshing a file never saves it.
 *
 *   Swift -> JS: window.nimbalystEditor.*
 *     - loadMarkdown(content: string): load markdown into editor
 *     - deferRemote(content: string): a remote version while edits are unsaved: take its
 *       frontmatter now, and its body only if the edits are undone (see pendingSave.ts)
 *     - flush(): { content, revision } | null: the save to persist now (frontmatter
 *       attached), as the editor closes; revision null when it cannot be acked
 *       (a save is still in flight); null when nothing is unsaved
 *     - saveResult(revision: number, ok: boolean): whether that save was persisted
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

import { joinFrontmatter, splitFrontmatter } from './frontmatter';
import { PendingSave } from './pendingSave';
import { authoredLinkHref } from './linkHref';
import './styles.css';

/** Update tag for content loaded from native; such updates are not user edits. */
const LOAD_TAG = 'nimbalyst-native-load';

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
  /** Frontmatter block as loaded; re-attached unchanged on save. */
  const frontmatterRef = useRef('');
  /** Debounced save of user edits (500ms) against the last loaded or saved body. */
  const saveRef = useRef<PendingSave | null>(null);
  if (!saveRef.current) {
    saveRef.current = new PendingSave({
      onDirty: (isDirty) => postToNative({ type: 'dirty', isDirty }),
      onSave: (revision, body) => {
        const content = joinFrontmatter(frontmatterRef.current, body);
        // A flush hands its save back to native synchronously (see flush below).
        if (flushCaptureRef.current) flushCaptureRef.current.request = { revision, content };
        else postToNative({ type: 'contentChanged', revision, content });
      },
      // Called from the update listener; load after it returns. The load
      // reports the editor clean.
      onReload: (body) => queueMicrotask(() => {
        const editor = editorRef.current;
        if (editor) reloadRef.current?.(editor, body);
      }),
    });
  }
  const pendingSave = saveRef.current;
  /** Set while `flush` runs, to take its save instead of posting it. */
  const flushCaptureRef = useRef<{ request: { revision: number; content: string } | null } | null>(null);
  /** applyBody, for the save's reload callback (created before it). */
  const reloadRef = useRef<((editor: LexicalEditor, body: string) => void) | null>(null);
  /** Body waiting for the editor to mount. */
  const pendingBodyRef = useRef<string | null>(null);

  const exportBody = useCallback((editor: LexicalEditor): string => {
    return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(getEditorTransformers()));
  }, []);

  // `loaded` (in onUpdate) drops any scheduled save and in-flight revision.
  const applyBody = useCallback((editor: LexicalEditor, body: string) => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        $convertFromEnhancedMarkdownString(body, getEditorTransformers());
      },
      {
        tag: LOAD_TAG,
        onUpdate: () => {
          pendingSave.loaded(exportBody(editor));
        },
      },
    );
  }, [exportBody, pendingSave]);
  reloadRef.current = applyBody;

  // Set up the Swift -> JS bridge
  useEffect(() => {
    const bridge = {
      loadMarkdown: (markdown: string) => {
        try {
          const { prefix, body } = splitFrontmatter(markdown);
          frontmatterRef.current = prefix;
          const editor = editorRef.current;
          if (editor) {
            applyBody(editor, body);
          } else {
            // Mount the editor empty; handleEditorReady loads the body through
            // the same tagged path so the load is never mistaken for an edit.
            pendingBodyRef.current = body;
            setContent('');
          }
        } catch (err) {
          postErrorToNative(err instanceof Error ? err : new Error(String(err)), 'loadMarkdown');
        }
      },

      // A remote version arrived while the user has unsaved body edits: the
      // body stays as typed, but the next save carries the remote frontmatter
      // (the phone never edits frontmatter, so the remote one is newest), and
      // undoing the edits shows the remote body.
      deferRemote: (markdown: string) => {
        const { prefix, body } = splitFrontmatter(markdown);
        frontmatterRef.current = prefix;
        pendingSave.deferRemote(body);
      },

      // The editor is closing: the save to persist now. With a revision when
      // it was emitted (native acks it); without one when a save is still in
      // flight and the newer content cannot wait for that ack.
      flush: (): { content: string; revision: number | null } | null => {
        const capture = { request: null as { revision: number; content: string } | null };
        flushCaptureRef.current = capture;
        try {
          pendingSave.flush();
        } finally {
          flushCaptureRef.current = null;
        }
        if (capture.request) return capture.request;
        const body = pendingSave.finalBody();
        return body === null ? null : { revision: null, content: joinFrontmatter(frontmatterRef.current, body) };
      },

      saveResult: (revision: number, ok: boolean) => {
        pendingSave.ack(revision, ok);
      },

      setReadOnly: (isReadOnly: boolean) => {
        setReadOnly(isReadOnly);
      },

      getContent: (): string => {
        const editor = editorRef.current;
        if (!editor) return '';
        return joinFrontmatter(frontmatterRef.current, exportBody(editor));
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
  }, [applyBody, exportBody]); // Stable callbacks -- runs once on mount

  // Links go to native, which opens wiki pages in the app and web links in
  // the browser. Without this the web view would navigate itself away from the
  // editor (relative links resolve against the bundle's file URL).
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('.mobile-editor a[href]');
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      postToNative({
        type: 'linkClicked',
        href: authoredLinkHref(editorRef.current, anchor),
        title: anchor.getAttribute('title'),
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Handle editor ready
  const handleEditorReady = useCallback((editor: LexicalEditor) => {
    editorRef.current = editor;

    // Listen for content changes to notify Swift
    editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      // Skip updates with no actual changes, and content native just loaded
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      if (tags.has(LOAD_TAG)) return;

      pendingSave.edited(editorState.read(() => $convertToEnhancedMarkdownString(getEditorTransformers())));
    });

    const pending = pendingBodyRef.current;
    pendingBodyRef.current = null;
    if (pending !== null) applyBody(editor, pending);
    else pendingSave.loaded(exportBody(editor));
  }, [applyBody, exportBody, pendingSave]);

  // Build editor config
  const editorConfig: EditorConfig = {
    editable: !readOnly,
    showToolbar: false,
    initialContent: content ?? undefined,
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
