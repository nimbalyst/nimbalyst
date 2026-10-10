/**
 * Mobile Lexical Editor for the Android WebView.
 *
 * Forked from packages/ios/src/editor-mobile/main.tsx. The bridge API is the
 * same; only the transport and change reporting differ.
 *
 * Bridge API:
 *   JS -> Android: window.AndroidEditorBridge.postMessage(JSON.stringify({ type, ... }))
 *     - editorReady: editor mounted and ready
 *     - dirty: { isDirty } true on a user edit, false when an undo returns to the saved body
 *     - contentChanged: { content, revision } a save to persist: after typing (debounced 500ms)
 *       or a flush; native answers saveResult(revision, ok). See pendingSave.ts.
 *     - linkClicked: a link was tapped ({ href, title }); native decides where it goes
 *     - error: JS error occurred
 *
 *   Android -> JS: window.nimbalystEditor.*
 *     - loadMarkdown(content: string): load markdown into editor
 *     - deferRemote(content: string): a remote version while edits are unsaved: take its
 *       frontmatter now, and its body only if the edits are undone (see pendingSave.ts)
 *     - saveResult(revision: number, ok: boolean): native's answer for a contentChanged
 *     - flush(): save now instead of after the debounce (Save button, app going to background)
 *     - finalContent(): string | null: the unsaved file for an editor being destroyed
 *     - setReadOnly(readonly: boolean): toggle read-only mode
 *     - getContent(): string: get current markdown content
 *     - formatText(format: string): apply text format (bold, italic, underline, strikethrough, code)
 *
 * Only user edits are reported. Content set by loadMarkdown (the initial load
 * or a remote update) becomes the new baseline, so opening a file or receiving
 * another device's save never echoes a save back to the server.
 *
 * Only the body goes through Lexical. The frontmatter text is kept as loaded
 * and re-attached on every save (see frontmatter.ts).
 *
 * CRITICAL: All hooks must come BEFORE any early returns. The WebView swallows
 * JS errors silently -- a hooks violation will blank the screen with no
 * diagnostic output.
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

const LOAD_TAG = 'nimbalyst-load';

// ============================================================================
// Bridge helpers
// ============================================================================

function postToNative(message: Record<string, unknown>): void {
  try {
    (window as any).AndroidEditorBridge?.postMessage(JSON.stringify(message));
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

function exportBody(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(getEditorTransformers()));
}

function EditorApp(): React.ReactElement {
  // -- All hooks BEFORE any early return --
  const [content, setContent] = useState<string | null>(null);
  const editorRef = useRef<LexicalEditor | null>(null);
  // Read once at mount: flipping `editable` in the config rebuilds the editor
  // from `initialContent` and would drop unsaved edits, so later changes go
  // through editor.setEditable instead.
  const readOnlyRef = useRef(false);
  const initialEditableRef = useRef(true);
  /** Frontmatter block as loaded; re-attached unchanged on save. */
  const frontmatterRef = useRef('');
  /** Every save starts here and is confirmed only by native's saveResult. */
  const saveRef = useRef<PendingSave | null>(null);
  if (!saveRef.current) {
    saveRef.current = new PendingSave({
      onDirty: (isDirty) => postToNative({ type: 'dirty', isDirty }),
      onSave: (revision, body) =>
        postToNative({ type: 'contentChanged', revision, content: joinFrontmatter(frontmatterRef.current, body) }),
      // Called from the update listener; load after it returns.
      onReload: (body) => queueMicrotask(() => {
        const editor = editorRef.current;
        if (editor) reloadRef.current?.(editor, body);
      }),
    });
  }
  const pendingSave = saveRef.current;
  /** applyBody, for the save's reload callback (created before it). */
  const reloadRef = useRef<((editor: LexicalEditor, body: string) => void) | null>(null);
  /** Body waiting for the editor to mount. */
  const pendingBodyRef = useRef<string | null>(null);

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
  }, [pendingSave]);
  reloadRef.current = applyBody;

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

      saveResult: (revision: number, ok: boolean) => {
        pendingSave.ack(revision, ok);
      },

      flush: () => {
        pendingSave.flush();
      },

      // The editor is being destroyed and cannot wait for an ack.
      finalContent: (): string | null => {
        const body = pendingSave.finalBody();
        return body === null ? null : joinFrontmatter(frontmatterRef.current, body);
      },

      setReadOnly: (isReadOnly: boolean) => {
        readOnlyRef.current = isReadOnly;
        if (editorRef.current) {
          editorRef.current.setEditable(!isReadOnly);
        } else {
          initialEditableRef.current = !isReadOnly;
        }
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
    postToNative({ type: 'editorReady' });

    return () => {
      delete (window as any).nimbalystEditor;
    };
  }, [applyBody]);

  // Links go to native, which opens wiki pages in the app and web links in
  // the browser. Without this the WebView would try to navigate itself
  // (relative links resolve against the bundle's file URL and are blocked).
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

  const handleEditorReady = useCallback((editor: LexicalEditor) => {
    editorRef.current = editor;
    editor.setEditable(!readOnlyRef.current);

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
  }, [applyBody, pendingSave]);

  const editorConfig: EditorConfig = {
    editable: initialEditableRef.current,
    showToolbar: false,
    initialContent: content ?? undefined,
    onEditorReady: handleEditorReady,
  };

  // Show placeholder until Android calls loadMarkdown
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
