/**
 * MonacoEditor - EditorHost-aware wrapper for Monaco
 *
 * Adapts MonacoCodeEditor to work with EditorHost interface.
 * This component follows the same pattern as MarkdownEditor:
 * - Receives EditorHost as prop
 * - Loads content via host.loadContent()
 * - Saves content via host.saveContent()
 * - Reports dirty state via host.setDirty()
 *
 * This creates a clean separation:
 * - MonacoCodeEditor: Pure Monaco wrapper, handles diff mode
 * - MonacoEditor: Adapts Monaco to EditorHost interface
 * - TabEditor: Provides EditorHost, doesn't know about editor internals
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type * as Y from 'yjs';
import { MonacoCodeEditor } from './MonacoCodeEditor';
import { createMonacoCollabBinding } from './monacoCollabBinding';
import { waitForMonacoModel } from './monacoModelReady';
import { useCollaborativeEditor } from '../extensions/useCollaborativeEditor';
import type { EditorHost } from '../extensions/editorHost';
import type { ConfigTheme } from '../editor';
import type { editor as MonacoEditorType } from 'monaco-editor';

/**
 * Opt-in collaboration config for MonacoEditor. When provided AND the host
 * exposes `host.collaboration`, MonacoEditor binds its model to a shared
 * `Y.Text` (via `createMonacoCollabBinding`) and SKIPS its local
 * load/save/file-change handling -- the binding + sync layer own content.
 *
 * The bound `Y.Text` field MUST match the document's CollabContentAdapter
 * (use `createTextCollabContentAdapter` with the same `textField`).
 */
export interface MonacoEditorCollabConfig {
  /** Y.Text field to bind. Default 'content'. */
  textField?: string;
  /** Override the empty-check used to decide whether to seed. Default: the
   *  bound field has zero length. */
  isEmpty?: (yDoc: Y.Doc) => boolean;
  /** Seed an empty shared doc from this client's file content. Default:
   *  insert the decoded text into the bound field once. */
  initializeFromContent?: (yDoc: Y.Doc, content: string | ArrayBuffer) => void;
  /** Called once the live binding is attached -- lets the host editor do
   *  binding-time setup (e.g. hide a frontmatter region via setHiddenAreas). */
  onBindingReady?: (ctx: {
    editor: MonacoEditorType.IStandaloneCodeEditor;
    monaco: typeof import('monaco-editor');
    yText: Y.Text;
  }) => void;
}

export interface MonacoEditorConfig {
  /** Theme for the editor */
  theme?: ConfigTheme;

  /** Extension theme ID for custom Monaco themes (e.g., 'sample-themes:solarized-light') */
  extensionThemeId?: string;

  /** Whether this editor's tab is active */
  isActive?: boolean;

  /** Optional Monaco construction overrides for normal edit mode */
  editorOptions?: MonacoEditorType.IStandaloneEditorConstructionOptions;

  /** Optional transform from stored file content to visible editor content */
  transformLoadContent?: (content: string) => string;

  /** Optional transform from visible editor content back to stored file content */
  transformSaveContent?: (content: string) => string;
}

export interface MonacoEditorProps {
  /** Host service for all editor-host communication */
  host: EditorHost;

  /** File name for language detection */
  fileName: string;

  /** Optional configuration */
  config?: MonacoEditorConfig;

  /** Opt-in collaboration. When set and `host.collaboration` is active, the
   *  model is bound to a shared Y.Text and local load/save are skipped. */
  collab?: MonacoEditorCollabConfig;

  /** Callback when editor is ready (passes editor instance with diff controls) */
  onEditorReady?: (editor: any) => void;

  /** Callback when getContent function is available */
  onGetContent?: (getContentFn: () => string) => void;

  /** Callback when diff change count updates (for diff header UI) */
  onDiffChangeCountUpdate?: (count: number) => void;
}

/**
 * MonacoEditor - EditorHost-aware wrapper for Monaco
 *
 * This component handles all EditorHost integration:
 * - Content loading on mount
 * - Save request handling (autosave, manual save)
 * - File change notifications
 * - Dirty state reporting
 * - Diff mode (for AI edit review)
 */
export function MonacoEditor({
  host,
  fileName,
  config = {},
  collab,
  onEditorReady,
  onGetContent: onGetContentProp,
  onDiffChangeCountUpdate,
}: MonacoEditorProps): React.ReactElement {
  const transformLoadContent = config.transformLoadContent;
  const transformSaveContent = config.transformSaveContent;

  // Collaborative when a collab config is supplied AND the host stood up a
  // collaboration channel. In that mode the Y.Text binding owns content, so we
  // skip local load/save/file-change handling (which would fight the binding).
  const collaborative = !!host.collaboration && !!collab;
  const collabField = collab?.textField ?? 'content';

  // Loading state - we load content via host.loadContent()
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [initialContent, setInitialContent] = useState<string>('');

  // Editor wrapper ref (contains editor, setContent, showDiff, etc.)
  const editorWrapperRef = useRef<any>(null);

  // Function to get current content from editor
  const getContentFnRef = useRef<(() => string) | null>(null);

  // Promise that resolves with the editor wrapper once Monaco has mounted, so
  // the collab binding can defer until a model exists (createBinding may fire
  // before or after onEditorReady, depending on sync timing).
  const editorReadyRef = useRef<{
    promise: Promise<any>;
    resolve: (wrapper: any) => void;
  } | null>(null);
  if (!editorReadyRef.current) {
    let resolve!: (wrapper: any) => void;
    const promise = new Promise<any>((r) => {
      resolve = r;
    });
    editorReadyRef.current = { promise, resolve };
  }

  // Live collaborative binding (no-op when host.collaboration is undefined).
  useCollaborativeEditor(host, {
    isEmpty: collab?.isEmpty,
    initializeFromContent:
      collab?.initializeFromContent ??
      ((yDoc, content) => {
        const yText = yDoc.getText(collabField);
        if (yText.length > 0) return;
        const text =
          typeof content === 'string'
            ? content
            : new TextDecoder('utf-8').decode(content);
        if (text) yText.insert(0, text);
      }),
    createBinding: async ({ yDoc, awareness }) => {
      if (!collab) return { destroy: () => {} };
      // Wait until Monaco has mounted at least once, then read the LIVE
      // wrapper. A remount (StrictMode double-mount, diff-mode
      // <Editor>/<DiffEditor> swap, tab reactivation) can replace the editor
      // after the one-shot promise resolved and dispose the original's model;
      // editorWrapperRef.current always points at the current instance.
      await editorReadyRef.current!.promise;
      const editor = editorWrapperRef.current
        ?.editor as MonacoEditorType.IStandaloneCodeEditor | undefined;
      if (!editor) return { destroy: () => {} };
      // The model may be transiently absent right after a remount. Wait for it
      // rather than throwing; if the editor disposes first, skip binding.
      const model = await waitForMonacoModel(editor);
      if (!model) return { destroy: () => {} };
      const yText = yDoc.getText(collabField);
      const handle = createMonacoCollabBinding({ yText, editor, awareness });
      try {
        collab.onBindingReady?.({
          editor,
          monaco: editorWrapperRef.current!.monaco,
          yText,
        });
      } catch (err) {
        console.error('[MonacoEditor] collab onBindingReady failed:', err);
      }
      return { destroy: () => handle.destroy() };
    },
  });

  // Load initial content on mount (skipped in collab mode: the binding fills
  // the model from the shared Y.Text once sync completes).
  useEffect(() => {
    if (collaborative) {
      setInitialContent('');
      setIsLoading(false);
      return;
    }

    let mounted = true;

    const loadContent = async () => {
      try {
        setIsLoading(true);
        const content = await host.loadContent();
        if (mounted) {
          setInitialContent(transformLoadContent?.(content) ?? content);
          setIsLoading(false);
        }
      } catch (error) {
        if (mounted) {
          setLoadError(error instanceof Error ? error : new Error('Failed to load content'));
          setIsLoading(false);
        }
      }
    };

    loadContent();

    return () => {
      mounted = false;
    };
  }, [host, transformLoadContent, collaborative]);

  // Subscribe to save requests from host (autosave timer, manual Cmd+S).
  // Skipped in collab mode -- persistence flows through the sync layer.
  useEffect(() => {
    if (collaborative) return;
    const handleSaveRequest = async () => {
      if (!getContentFnRef.current) {
        console.warn('[MonacoEditor] No getContent function available for save');
        return;
      }

      try {
        const content = getContentFnRef.current();
        await host.saveContent(transformSaveContent?.(content) ?? content);
      } catch (error) {
        console.error('[MonacoEditor] Save failed:', error);
      }
    };

    const unsubscribe = host.onSaveRequested(handleSaveRequest);
    return unsubscribe;
  }, [host, transformSaveContent, collaborative]);

  // Subscribe to file changes (external edits). Skipped in collab mode -- the
  // binding is the source of truth; a local-file echo would clobber it.
  useEffect(() => {
    if (collaborative) return;
    const handleFileChanged = (newContent: string) => {
      // Use editor's setContent method to update content
      if (editorWrapperRef.current?.setContent) {
        editorWrapperRef.current.setContent(transformLoadContent?.(newContent) ?? newContent);
      }
    };

    const unsubscribe = host.onFileChanged(handleFileChanged);
    return unsubscribe;
  }, [host, transformLoadContent, collaborative]);

  // NOTE: We intentionally do NOT subscribe to diff requests here.
  // Monaco diff handling is fully implemented in TabEditor.tsx which calls
  // editorRef.current.showDiff() and sets showMonacoDiffBar to display the
  // unified diff header. If we subscribed here, TabEditor would take the
  // "custom editor" code path (diffRequestCallbackRef) which sets the wrong
  // diff bar state (showCustomEditorDiffBar instead of showMonacoDiffBar).
  //
  // Custom editors that implement their own diff display should subscribe
  // to onDiffRequested. For Monaco, TabEditor handles it directly.

  // Handle dirty state changes from Monaco
  const handleDirtyChange = useCallback(
    (isDirty: boolean) => {
      host.setDirty(isDirty);
    },
    [host]
  );

  // Handle getContent callback from Monaco
  const handleGetContent = useCallback((getContentFn: () => string) => {
    getContentFnRef.current = getContentFn;
    // Also notify parent if they need the getContent function
    onGetContentProp?.(getContentFn);
  }, [onGetContentProp]);

  // Handle editor ready (Monaco wrapper with diff controls)
  const handleEditorReady = useCallback(
    (editorWrapper: any) => {
      editorWrapperRef.current = editorWrapper;
      // Unblock any pending collab binding waiting for the model to exist.
      editorReadyRef.current?.resolve(editorWrapper);
      onEditorReady?.(editorWrapper);
    },
    [onEditorReady]
  );

  // Show loading state
  if (isLoading) {
    return (
      <div className="monaco-editor-loading" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--nim-text-muted)'
      }}>
        <span>Loading...</span>
      </div>
    );
  }

  // Show error state
  if (loadError) {
    return (
      <div className="monaco-editor-error" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--nim-error)'
      }}>
        <span>Failed to load: {loadError.message}</span>
      </div>
    );
  }

  // Render MonacoCodeEditor with EditorHost integration
  return (
    <MonacoCodeEditor
      filePath={host.filePath}
      fileName={fileName}
      initialContent={initialContent}
      theme={(config.theme ?? host.theme) as ConfigTheme}
      extensionThemeId={config.extensionThemeId}
      isActive={config.isActive}
      editorOptions={config.editorOptions}
      onDirtyChange={handleDirtyChange}
      onGetContent={handleGetContent}
      onEditorReady={handleEditorReady}
      onDiffChangeCountUpdate={onDiffChangeCountUpdate}
    />
  );
}

export default MonacoEditor;
