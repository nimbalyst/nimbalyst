import type { Transformer } from '@lexical/markdown';
import type { ReactNode } from 'react';
import type { NodeKey } from 'lexical';
import type { Provider } from '@lexical/yjs';
import type { Doc } from 'yjs';

/**
 * Configuration interface for the Nimbalyst component.
 * This replaces the reactive settings system with static configuration props.
 */

/**
 * @deprecated Theme is now controlled at app level via CSS variables.
 * This type is kept for backwards compatibility.
 */
export type Theme = 'light' | 'dark' | 'auto' | (string & {});

export interface UploadedEditorAsset {
  kind: 'image' | 'file';
  src: string;
  name?: string;
  altText?: string;
}


/**
 * Removed features that are either incomplete, or not appropriate for an editor targeting markdown compatibility
 *
 * - isAutocomplete: Not implemented as pluggable
 * - isMaxLength: Can be external
 * - isCharLimit: Can be external
 * - isCharLimitUtf8: Can be external
 *
 * - isCollab: Not supported yet in Nimbalyst (See Lexical Playground)
 *
 * - shouldUseLexicalContextMenu: Not implemented as pluggable (or that useful)
 *
 *
 * Non markdown-safe table features
 * - tableCellBackgroundColor?: boolean;
 * - tableCellMerge?: boolean;
 *
 * Less sure about this one
 * - tableHorizontalScroll?: boolean;
 *
 *
 *
 *   // Not sure about these
 *   measureTypingPerf?: boolean;
 *   showNestedEditorTreeView?: boolean;
 */

export interface EditorConfig {

  // Core editor behavior
  isRichText?: boolean;

  // TODO: Do we need this? Think we either accept content or blank
  emptyEditor?: boolean;

  /** Make editor read-only */
  editable?: boolean;

  /** Open links in a new tab with rel="noopener noreferrer" */
  hasLinkAttributes?: boolean;

  /** Code highlighting enabled for blocks */
  isCodeHighlighted?: boolean;

  /** show selection even if editor is not focused */
  selectionAlwaysOnDisplay?: boolean;


  /** Should we always enable this? Seems appropriate */
  shouldPreserveNewLinesInMarkdown?: boolean;




  /** Show the hierarchical node tree view for debugging */
  showTreeView?: boolean;

  /** Show the toolbar at the top of the editor */
  showToolbar?: boolean;

  /** Show the floating text format toolbar even on small viewports (e.g. mobile) */
  forceFloatingToolbar?: boolean;

  // Is this only for testing?
  disableBeforeInput?: boolean;


  /** Strict or relaxed indentation for lists */
  listStrictIndent?: boolean;

  // This goes away after we're done whittling down the config right?
  // Markdown-only mode - hides non-markdown native features
  markdownOnly?: boolean;


  /**
   * @deprecated Theme is now controlled at app level via CSS variables on document root.
   * This prop is ignored. Use the app's theme system instead.
   */
  theme?: Theme;

  /** Optional markdown transformers to use for import/export in this editor */
  markdownTransformers?: Transformer[];

  // Content callbacks
  /**
   * Called when content changes (user makes edits).
   * No serialization happens - just signals that content changed.
   * TabEditor tracks dirty state and deduplicates calls.
   */
  onDirtyChange?: (isDirty: boolean) => void;

  onGetContent?: (getContentFn: () => string) => void;
  onEditorReady?: (editor: any) => void;
  onSaveRequest?: () => void;
  initialContent?: string; // Pre-loaded content to set in editor

  // Document action callbacks
  onViewHistory?: () => void;
  onRenameDocument?: () => void;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;
  onToggleMarkdownMode?: () => void;

  // Document metadata for AI sessions
  filePath?: string;
  workspaceId?: string;

  // Image interaction callbacks (platform-specific)
  onImageDoubleClick?: (src: string, nodeKey: NodeKey) => void;
  onImageDragStart?: (src: string, event: DragEvent) => void;
  onUploadAsset?: (file: File) => Promise<UploadedEditorAsset>;
  resolveImageSrc?: (src: string) => Promise<string | null>;
  /**
   * Fired (debounced) with the list of `collab-asset://` URIs that have
   * disappeared from the live editor state since the previous scan. Used
   * by the collab editor to garbage-collect orphaned attachments. The
   * callback receives only what was *removed*, never the full referenced
   * set, so it cannot delete still-live attachments referenced only by
   * other peers.
   */
  onAssetReferencesRemoved?: (removedUris: string[]) => void;

  // Document header - renders at the top of the editor scroll pane
  documentHeader?: ReactNode;

  // Collaboration mode
  /**
   * When set, the editor operates in collaborative mode:
   * - CollaborationPlugin replaces HistoryPlugin
   * - Content comes from Y.Doc instead of initialContent
   * - The providerFactory creates a Provider wrapping our DocumentSyncProvider
   */
  collaboration?: {
    /** Factory that returns a @lexical/yjs Provider for a given doc ID */
    providerFactory: (id: string, yjsDocMap: Map<string, Doc>) => Provider;
    /** Whether this is the first user to join (bootstraps empty doc) */
    shouldBootstrap: boolean;
    /** Display name for cursor labels */
    username?: string;
    /** Color for this user's cursor */
    cursorColor?: string;
    /**
     * Initial editor state to bootstrap when Y.Doc is empty.
     * Can be a function (called with editor), a serialized EditorState string,
     * or an EditorState object. Only used when shouldBootstrap is true.
     */
    initialEditorState?: (() => void) | string;
  };
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  isRichText: true,
  emptyEditor: false,
  editable: true,
  hasLinkAttributes: false,
  isCodeHighlighted: true,
  selectionAlwaysOnDisplay: true,
  shouldPreserveNewLinesInMarkdown: true,
  showTreeView: false,
  showToolbar: false,
  disableBeforeInput: false,
  listStrictIndent: false,
  markdownOnly: true,
  theme: 'auto',
};
