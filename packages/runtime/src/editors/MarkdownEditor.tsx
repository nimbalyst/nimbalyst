/**
 * MarkdownEditor Wrapper
 *
 * Adapts Rexical (the pure Lexical wrapper) to work with EditorHost.
 * This component follows the same pattern as custom editors:
 * - Receives EditorHost as prop
 * - Loads content via host.loadContent()
 * - Saves content via host.saveContent()
 * - Reports dirty state via host.setDirty()
 *
 * This creates a clean separation:
 * - Rexical: Pure Lexical wrapper, no platform knowledge
 * - MarkdownEditor: Adapts Rexical to EditorHost interface
 * - TabEditor: Provides EditorHost, doesn't know about editor internals
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  NimbalystEditor,
  type EditorConfig,
  type ConfigTheme,
  type UploadedEditorAsset,
  type CommentsConfig,
  $convertFromEnhancedMarkdownString,
  getEditorTransformers,
} from '../editor';
import type { EditorHost } from '../extensions/editorHost';
import { $getRoot } from 'lexical';

export interface MarkdownEditorConfig {
  /**
   * @deprecated Theme is now controlled at app level via CSS variables.
   * This prop is ignored. Theme is read from document root's data-theme attribute.
   */
  theme?: string;

  /** Whether the editor is read-only */
  editable?: boolean;

  /** Show the toolbar */
  showToolbar?: boolean;

  /** Document header element to render at top of scroll area */
  documentHeader?: React.ReactNode;

  /** Callback when user double-clicks an image */
  onImageDoubleClick?: (src: string, nodeKey: string) => void;

  /** Callback when user starts dragging an image */
  onImageDragStart?: (src: string, event: DragEvent) => void;

  /** Upload a dropped/pasted asset and return the inserted editor payload. */
  onUploadAsset?: (file: File) => Promise<UploadedEditorAsset>;

  /** Resolve editor image sources to browser-openable URLs. */
  resolveImageSrc?: (src: string) => Promise<string | null>;

  /**
   * Notified (debounced) with the URIs that have *disappeared* from the
   * live editor state since the previous scan. Wires through to AssetGCPlugin.
   */
  onAssetReferencesRemoved?: (removedUris: string[]) => void;

  /** Callback to rename document */
  onRenameDocument?: () => void;

  /** Callback to switch to agent mode */
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;

  /** Callback to open session in chat */
  onOpenSessionInChat?: (sessionId: string) => void;

  /** Callback to toggle markdown mode (switch to raw Monaco view) */
  onToggleMarkdownMode?: () => void;

  /** Show the debug tree view (dev mode only) */
  showTreeView?: boolean;
}

export interface MarkdownEditorProps {
  /** Host service for all editor-host communication */
  host: EditorHost;

  /** Optional configuration */
  config?: MarkdownEditorConfig;

  /** Callback when editor is ready (passes editor instance) */
  onEditorReady?: (editor: any) => void;

  /** Callback when getContent function is available (for mode switching) */
  onGetContent?: (getContentFn: () => string) => void;

  /**
   * When set (collaborative documents only), enables document comments
   * (text-selection MarkNode comments, `@`-mention picker, thread panel,
   * inbox fanout). Passed straight through to `EditorConfig.comments`.
   */
  commentsConfig?: CommentsConfig;

  /**
   * When set, the editor operates in collaborative mode:
   * - Content comes from Y.Doc instead of host.loadContent()
   * - CollaborationPlugin replaces HistoryPlugin
   * - Save/file-change subscriptions are skipped (unless personalSync is true)
   */
  collaborationConfig?: {
    providerFactory: (id: string, yjsDocMap: Map<string, import('yjs').Doc>) => import('@lexical/yjs').Provider;
    shouldBootstrap: boolean;
    username?: string;
    cursorColor?: string;
    /** Markdown content to seed the Y.Doc with when shouldBootstrap is true */
    initialContent?: string;
    /**
     * When true, this is personal multi-device sync (not team collaboration).
     * Disk operations (save, file-change) remain active alongside Yjs sync.
     * Content is seeded from disk into Y.Doc via shouldBootstrap + initialContent,
     * then Yjs keeps it in sync while autosave continues writing to disk.
     */
    personalSync?: boolean;
  };
}

/**
 * MarkdownEditor - EditorHost-aware wrapper for Rexical
 *
 * This component handles all EditorHost integration:
 * - Content loading on mount
 * - Save request handling (autosave, manual save)
 * - File change notifications
 * - Dirty state reporting
 * - Diff mode (optional)
 */
export function MarkdownEditor({
  host,
  config = {},
  onEditorReady,
  onGetContent: onGetContentProp,
  collaborationConfig,
  commentsConfig,
}: MarkdownEditorProps): React.ReactElement {
  const isCollabMode = !!collaborationConfig;
  // Personal sync: collab is active but disk operations continue
  const isPersonalSync = collaborationConfig?.personalSync === true;
  // Skip disk operations only in pure team collab mode (not personal sync)
  const skipDiskOps = isCollabMode && !isPersonalSync;

  // Loading state - we load content via host.loadContent()
  // In pure collab mode, content comes from Y.Doc, so we skip loading
  // In personal sync mode, we load from disk to seed the Y.Doc
  const [isLoading, setIsLoading] = useState(!skipDiskOps);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [initialContent, setInitialContent] = useState<string>('');

  // Editor instance ref
  const editorRef = useRef<any>(null);

  // Function to get current content from editor
  const getContentFnRef = useRef<(() => string) | null>(null);

  // Load initial content on mount (skip in pure collab mode, keep for personal sync)
  useEffect(() => {
    if (skipDiskOps) return; // CollaborationPlugin hydrates from Y.Doc

    let mounted = true;

    const loadContent = async () => {
      try {
        setIsLoading(true);
        const content = await host.loadContent();
        if (mounted) {
          setInitialContent(content);
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
  }, [host]);

  // Subscribe to save requests from host (autosave timer, manual Cmd+S)
  // In pure collab mode, saves go through the sync layer, not EditorHost
  // In personal sync mode, autosave continues writing to disk
  useEffect(() => {
    if (skipDiskOps) return; // No disk saves in pure collaboration mode

    const handleSaveRequest = async () => {
      if (!getContentFnRef.current) {
        console.warn('[MarkdownEditor] No getContent function available for save');
        return;
      }

      try {
        const content = getContentFnRef.current();
        await host.saveContent(content);
      } catch (error) {
        console.error('[MarkdownEditor] Save failed:', error);
      }
    };

    const unsubscribe = host.onSaveRequested(handleSaveRequest);
    return unsubscribe;
  }, [host, skipDiskOps]);

  // Subscribe to file changes (external edits)
  // In pure collab mode, changes come through Y.Doc, not file watcher
  // In personal sync mode, file changes still need handling (e.g., git pull)
  useEffect(() => {
    if (skipDiskOps) return; // No file watcher in pure collaboration mode

    const handleFileChanged = (newContent: string) => {
      // If we have an editor, update it with new content
      // The editor will decide whether to reload based on its internal state
      if (editorRef.current && editorRef.current.update) {
        // TODO: Import from editor and use proper update method
        console.log('[MarkdownEditor] File changed externally, updating editor');
        // For now, this will be implemented when we have the full Rexical integration
      }
    };

    const unsubscribe = host.onFileChanged(handleFileChanged);
    return unsubscribe;
  }, [host, skipDiskOps]);

  // NOTE: We intentionally do NOT subscribe to diff requests here.
  // Markdown diff handling is fully implemented in TabEditor.tsx using Lexical's
  // APPLY_MARKDOWN_REPLACE_COMMAND. If we subscribed here, TabEditor would take
  // the "custom editor" code path (diffRequestCallbackRef) which bypasses the
  // working Lexical diff implementation.
  //
  // Custom editors that implement their own diff display should subscribe
  // to onDiffRequested. For markdown, TabEditor handles it directly.

  // Handle content change from Rexical
  // This is called on dirty state changes, NOT content serialization
  const handleDirtyChange = useCallback(
    (isDirty: boolean) => {
      host.setDirty(isDirty);
    },
    [host]
  );

  // Handle getContent callback from Rexical
  const handleGetContent = useCallback((getContentFn: () => string) => {
    getContentFnRef.current = getContentFn;
    // Also notify parent if they need the getContent function (e.g., for mode switching)
    onGetContentProp?.(getContentFn);
  }, [onGetContentProp]);

  // Handle editor ready
  const handleEditorReady = useCallback(
    (editor: any) => {
      editorRef.current = editor;
      onEditorReady?.(editor);
    },
    [onEditorReady]
  );

  // Handle view history
  const handleViewHistory = useCallback(() => {
    host.openHistory();
  }, [host]);

  // Build config for NimbalystEditor
  // Note: We use config.theme directly in dependencies because host.theme is a getter
  // that reads from a ref, so it won't trigger re-computation when the ref changes.
  const editorConfig = useMemo(
    (): EditorConfig => ({
      theme: (config.theme ?? host.theme) as ConfigTheme,
      editable: config.editable,
      showToolbar: config.showToolbar,
      showTreeView: config.showTreeView,
      documentHeader: config.documentHeader,
      onImageDoubleClick: config.onImageDoubleClick,
      onImageDragStart: config.onImageDragStart,
      onUploadAsset: config.onUploadAsset,
      resolveImageSrc: config.resolveImageSrc,
      onAssetReferencesRemoved: config.onAssetReferencesRemoved,
      onViewHistory: handleViewHistory,
      onRenameDocument: config.onRenameDocument,
      onSwitchToAgentMode: config.onSwitchToAgentMode,
      onOpenSessionInChat: config.onOpenSessionInChat,
      onToggleMarkdownMode: config.onToggleMarkdownMode,
      filePath: host.filePath,
      workspaceId: host.workspaceId,

      // Content callbacks - using new pattern
      // In pure collab mode, content comes from Y.Doc. In personal sync, load from disk.
      initialContent: skipDiskOps ? undefined : initialContent,
      onDirtyChange: handleDirtyChange,
      onGetContent: handleGetContent,
      onEditorReady: handleEditorReady,

      // Collaboration mode -- passed through to Editor.tsx
      collaboration: collaborationConfig ? (() => {
        const hasInitial = collaborationConfig.shouldBootstrap && collaborationConfig.initialContent;
        console.log('[MarkdownEditor] Building collab config, shouldBootstrap:', collaborationConfig.shouldBootstrap,
          'hasInitialContent:', !!collaborationConfig.initialContent,
          'will provide initialEditorState:', !!hasInitial);
        return {
          providerFactory: collaborationConfig.providerFactory,
          shouldBootstrap: collaborationConfig.shouldBootstrap,
          username: collaborationConfig.username,
          cursorColor: collaborationConfig.cursorColor,
          // When bootstrapping with initial content, provide a function that
          // parses the markdown into the editor. CollaborationPlugin calls this
          // inside editor.update() when the Y.Doc is empty after initial sync.
          initialEditorState: hasInitial
            ? () => {
                console.log('[MarkdownEditor] initialEditorState called! Parsing markdown content, length:', collaborationConfig.initialContent!.length);
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(collaborationConfig.initialContent!, getEditorTransformers());
              }
            : undefined,
        };
      })() : undefined,

      // Document comments (collaborative documents only).
      comments: commentsConfig,
    }),
    [
      config.theme,
      config.editable,
      config.showToolbar,
      config.showTreeView,
      config.documentHeader,
      config.onImageDoubleClick,
      config.onImageDragStart,
      config.onUploadAsset,
      config.resolveImageSrc,
      config.onAssetReferencesRemoved,
      config.onRenameDocument,
      config.onSwitchToAgentMode,
      config.onOpenSessionInChat,
      config.onToggleMarkdownMode,
      host.filePath,
      host.workspaceId,
      isCollabMode,
      skipDiskOps,
      initialContent,
      handleDirtyChange,
      handleGetContent,
      handleEditorReady,
      handleViewHistory,
      collaborationConfig,
      commentsConfig,
    ]
  );

  // Show loading state
  if (isLoading) {
    return (
      <div className="markdown-editor-loading">
        <span>Loading...</span>
      </div>
    );
  }

  // Show error state
  if (loadError) {
    return (
      <div className="markdown-editor-error">
        <span>Failed to load: {loadError.message}</span>
      </div>
    );
  }

  // Render NimbalystEditor with EditorHost integration
  return <NimbalystEditor config={editorConfig} />;
}

export default MarkdownEditor;
