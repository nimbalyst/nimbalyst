 /**
 * TabEditor - Fully encapsulated editor component for a single file
 *
 * This component owns ALL state for managing one editor instance:
 * - Content and dirty state
 * - Autosave timer
 * - File watching
 * - Manual save
 * - History snapshots
 *
 * Props are minimal - just what the component needs from parent coordination.
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { usePostHog } from 'posthog-js/react';
import type { ConfigTheme } from '@nimbalyst/runtime';
import { DocumentPathProvider, MarkdownEditor, MonacoEditor, MonacoCodeEditor } from '@nimbalyst/runtime';
import { useTheme } from '../../hooks/useTheme';
import {
  NimbalystEditor,
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  getEditorTransformers,
  APPLY_MARKDOWN_REPLACE_COMMAND,
  APPROVE_DIFF_COMMAND,
  REJECT_DIFF_COMMAND,
  CLEAR_DIFF_TAG_COMMAND,
  INCREMENTAL_APPROVAL_COMMAND,
  $hasDiffNodes,
  $approveDiffs,
  $rejectDiffs
} from '@nimbalyst/runtime';
import { $getRoot, $getSelection, $isRangeSelection, SKIP_SCROLL_INTO_VIEW_TAG, SKIP_DOM_SELECTION_TAG, COMMAND_PRIORITY_LOW } from 'lexical';
import { DocumentHeaderContainer } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader';
// Side-effect import: registers GenericFrontmatterHeader with DocumentHeaderRegistry
import '@nimbalyst/runtime/plugins/FrontmatterPlugin';
import { setTextSelection, clearTextSelection } from '../UnifiedAI/TextSelectionIndicator';
import { FixedTabHeaderContainer, FixedTabHeaderRegistry } from '@nimbalyst/runtime/plugins/shared/fixedTabHeader';
import { UnifiedDiffHeader, LexicalDiffHeaderAdapter } from '../UnifiedDiffHeader';
import { ImageViewer } from '../ImageViewer';
import { getFileType } from '../../utils/fileTypeDetector';
import { customEditorRegistry, CustomEditorWrapper } from '../CustomEditors';
import { logger } from '../../utils/logger';
import { createEditorHost } from './createEditorHost';
import type { EditorHost, DiffConfig } from '@nimbalyst/runtime';
import { createExtensionStorage } from '@nimbalyst/runtime';
import { setEditorContext, clearEditorContext } from '../../stores/editorContextStore';
import { store, editorHasUnacceptedChangesAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { historyDialogFileAtom } from '../../store';
import { UnifiedEditorHeaderBar } from './UnifiedEditorHeaderBar';
import { usePersonalDocSync } from '../../hooks/usePersonalDocSync';
import { useDocumentModel } from '../../services/document-model/useDocumentModel';
import { DocumentModelRegistry } from '../../services/document-model/DocumentModelRegistry';
import type { DiffState } from '../../services/document-model/types';
import { diffTrace } from '@nimbalyst/runtime/utils/debugFlags';

/** Normalize a file path for comparison: backslashes to forward slashes, strip trailing slashes. */
function normalizePathForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Build the update tags for a programmatic external/agent content replacement.
 *
 * When the Lexical editor does NOT currently hold DOM focus (e.g. the user is
 * typing in the AI chat box while an agent edits the open file), add
 * SKIP_DOM_SELECTION_TAG so Lexical's reconciler does not move browser focus and
 * selection into the contentEditable, which would hijack the user's keystrokes.
 * When the editor IS focused (user is actively editing it), keep the prior
 * behavior so selection stays in sync.
 */
function externalContentUpdateTags(editor: { getRootElement?: () => HTMLElement | null }): string[] {
  const tags: string[] = [SKIP_SCROLL_INTO_VIEW_TAG];
  const root = editor.getRootElement?.();
  const editorHasFocus =
    !!root && typeof document !== 'undefined' && root.contains(document.activeElement);
  if (!editorHasFocus) {
    tags.push(SKIP_DOM_SELECTION_TAG);
  }
  return tags;
}

interface TabEditorProps {
  // Identification
  filePath: string;
  fileName: string;

  // Initial state
  initialContent: string;

  // Configuration
  isActive: boolean;

  // Optional features
  textReplacements?: Array<{ oldText?: string; newText: string }>;
  autosaveInterval?: number; // milliseconds, default 2000
  autosaveDebounce?: number; // milliseconds, default 200
  periodicSnapshotInterval?: number; // milliseconds, default 300000 (5 minutes)

  // Callbacks to parent
  onDirtyChange?: (isDirty: boolean) => void; // Used by custom editors to update tab store
  onSaveComplete?: (filePath: string) => void;

  // External control (exposed via imperative handle)
  onManualSaveReady?: (saveFunction: () => Promise<void>) => void;
  onGetContentReady?: (getContentFunction: () => string) => void;

  // Document action callbacks
  onRenameDocument?: () => void;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;

  // Document metadata
  workspaceId?: string;
}

export const TabEditor: React.FC<TabEditorProps> = ({
                                                      filePath,
                                                      fileName,
                                                      initialContent,
                                                      isActive,
                                                      textReplacements,
                                                      autosaveInterval = 2000,
                                                      autosaveDebounce = 200,
                                                      periodicSnapshotInterval = 300000,
                                                      onDirtyChange,
                                                      onSaveComplete,
                                                      onManualSaveReady,
                                                      onGetContentReady,
                                                      onRenameDocument,
                                                      onSwitchToAgentMode,
                                                      onOpenSessionInChat,
                                                      workspaceId,
                                                    }) => {
  // Use theme hook directly so we get live updates when theme changes
  // (TabContent creates each TabEditor in a separate React root, so prop updates don't work)
  const { theme, themeId } = useTheme();

  // Debug: log every render to verify isDirty changes don't cause re-renders
  // console.log('[TabEditor] render', fileName);

  const posthog = usePostHog();

  // Acquire a DocumentModel for this file (shared across all editors of the same file).
  // The model owns the autosave timer, file-watcher coordination, and diff state.
  // The handle is this editor's attachment for communicating with the model.
  const { model: documentModel, handle: documentModelHandle } = useDocumentModel(filePath, {
    autosaveInterval,
    autosaveDebounce,
  });

  // Initialize the model's echo-suppression baseline with the content we already have.
  // This prevents the first file-watcher event (from our own initial state) from
  // being treated as an external change.
  if (documentModel.getLastPersistedContent() === null) {
    documentModel.setLastPersistedContent(initialContent);
  }

  // Subscribe to custom editor registry changes to re-evaluate file type
  // when extensions finish loading (handles race condition on startup)
  const [registryVersion, setRegistryVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = customEditorRegistry.onChange(() => {
      setRegistryVersion(v => v + 1);
    });
    return unsubscribe;
  }, []);

  // Detect file type (markdown vs code vs image vs custom)
  // Re-computed when registry changes (registryVersion dependency)
  const fileType = useMemo(() => {
    const checkCustomEditor = (): boolean =>
      customEditorRegistry.findRegistrationForFile(filePath) !== undefined;
    return getFileType(filePath, checkCustomEditor);
  }, [filePath, registryVersion]);

  const isMarkdown = fileType === 'markdown';
  const isImage = fileType === 'image';
  const isCustom = fileType === 'custom';

  // Get the custom editor registration for this file (used for source mode and storage)
  const customEditorRegistration = useMemo(() => {
    if (!isCustom) return null;
    return customEditorRegistry.findRegistrationForFile(filePath) ?? null;
  }, [isCustom, filePath, registryVersion]);

  // Check if the custom editor supports source mode (from registry)
  const customEditorSupportsSourceMode = customEditorRegistration?.supportsSourceMode || false;
  const customEditorSupportsDiffMode = customEditorRegistration?.supportsDiffMode === true;
  const customEditorShowsDocumentHeader = customEditorRegistration?.showDocumentHeader !== false;

  // Source mode state - unified for both markdown and custom editors
  // When true, shows Monaco with raw content; when false, shows rich editor (Lexical or custom)
  const [sourceMode, setSourceMode] = useState(false);

  // Personal document sync (multi-device sync for .md files)
  const { collaborationConfig: personalSyncConfig } = usePersonalDocSync(
    filePath,
    initialContent,
    isMarkdown,
  );

  // NOTE: content state has been removed. Editors own their content.
  // TabEditor extracts content via getContentFnRef.current() when needed for saves, diffs, etc.
  // contentRef tracks the working copy, lastSavedContentRef tracks what was saved to disk.
  // NOTE: isDirty is tracked via ref only, not state, to avoid re-renders when dirty state changes.
  // The parent is notified via onDirtyChange callback.
  // NOTE: lastSaveTime and lastSavedContent are refs, not state, to avoid re-renders on save
  // They're only used for file watcher comparison, not for rendering
  const [reloadVersion, setReloadVersion] = useState(0);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [conflictDialogContent, setConflictDialogContent] = useState<string>('');
  // Non-blocking autosave conflict banner. Set when autosave detects an
  // external change to disk while the buffer is dirty. The buffer is
  // preserved -- the user clicks "Reload" to pick up the disk content.
  const [autosaveConflictDiskContent, setAutosaveConflictDiskContent] = useState<string | null>(null);
  const [showMonacoDiffBar, setShowMonacoDiffBar] = useState(false); // For Monaco diff approval bar
  const [showCustomEditorDiffBar, setShowCustomEditorDiffBar] = useState(false); // For custom editor diff approval bar
  const [isEditorReady, setIsEditorReady] = useState(false); // Track when editor is mounted and ready
  const [diffSessionInfo, setDiffSessionInfo] = useState<{sessionId: string; sessionTitle?: string; editedAt?: number; provider?: string} | null>(null); // Session info for diff approval bar
  const [monacoDiffChangeCount, setMonacoDiffChangeCount] = useState(0); // Number of changes in Monaco diff mode
  const [showTreeView, setShowTreeView] = useState(false); // Debug tree view for Lexical (dev mode only)

  // Track editor type usage when file is opened
  const hasTrackedOpenRef = useRef<string | null>(null);
  useEffect(() => {
    // Only track once per file path when it becomes active
    if (isActive && isEditorReady && hasTrackedOpenRef.current !== filePath) {
      hasTrackedOpenRef.current = filePath;

      // Determine file extension and editor category for tracking.
      // For custom editors, prefer the registered key (e.g., '.reddit.watch.json',
      // '.mockup.html') so analytics reflects the compound extension the editor
      // was matched on, not just the file's final segment.
      const customMatch = customEditorRegistry.findMatchForFile(filePath);
      let fileExtension: string;
      if (customMatch) {
        fileExtension = customMatch.key;
      } else {
        const lastDot = filePath.lastIndexOf('.');
        fileExtension = lastDot >= 0 ? filePath.substring(lastDot).toLowerCase() : '';
      }

      let editorCategory = 'monaco'; // default for code files
      let hasMermaid = false;
      let hasDataModel = false;

      if (isMarkdown) {
        editorCategory = 'markdown';
        // Check if markdown contains Mermaid diagrams
        if (initialContent.includes('```mermaid') || initialContent.includes('~~~mermaid')) {
          hasMermaid = true;
        }
        // Check if markdown contains DataModel references
        if (initialContent.includes('```datamodel') || initialContent.includes('datamodel:')) {
          hasDataModel = true;
        }
      } else if (isImage) {
        editorCategory = 'image';
      } else if (isCustom) {
        // Use the registered editor name (e.g., "Spreadsheet Editor", "PDF Viewer")
        editorCategory = customMatch?.registration.name || 'custom';
      }

      posthog?.capture('editor_type_opened', {
        editorCategory,
        fileExtension,
        hasMermaid,
        hasDataModel,
      });
    }
  }, [isActive, isEditorReady, filePath, isMarkdown, isImage, isCustom, posthog, initialContent]);

  // Track current file path to abort operations when switching files
  const currentFilePathRef = useRef(filePath);

  useEffect(() => {
    currentFilePathRef.current = filePath;
    setSourceMode(false); // Reset source mode when switching files
  }, [filePath]);

  // Refs for stable access in timers/callbacks
  const contentRef = useRef(initialContent);
  const isDirtyRef = useRef(false);
  const getContentFnRef = useRef<(() => string) | null>(null);
  const editorRef = useRef<any>(null);
  const initialContentRef = useRef(initialContent);
  const lastSaveTimeRef = useRef<number | null>(null);
  const lastSavedContentRef = useRef<string>(initialContent);
  const isSavingRef = useRef<boolean>(false);
  const saveIdRef = useRef<number>(0);
  const pendingSaveIdsRef = useRef<Set<number>>(new Set());
  const instanceIdRef = useRef<number>(Math.floor(Math.random() * 10000));
  const hasInitialContentSyncRef = useRef<boolean>(false);
  const pendingAIEditTagRef = useRef<{tagId: string, sessionId: string, filePath: string} | null>(null);
  const isApplyingDiffRef = useRef<boolean>(false); // Track programmatic diff application
  const isApplyingExternalContentRef = useRef<boolean>(false); // Guard: programmatic content update from sibling save
  const isClearingDiffTagRef = useRef<boolean>(false); // Guard against pending-cleared reload race
  const editorHostFileChangeCallbackRef = useRef<((newContent: string) => void) | null>(null); // For EditorHost file change subscription
  const diffRequestCallbackRef = useRef<((config: DiffConfig) => void) | null>(null); // For EditorHost diff request subscription
  const diffClearedCallbackRef = useRef<(() => void) | null>(null); // For EditorHost diff cleared subscription
  const editorHostSaveRequestCallbackRef = useRef<(() => void | Promise<void>) | null>(null); // For EditorHost save request subscription
  const sourceModeChangedCallbackRef = useRef<((isSourceMode: boolean) => void) | null>(null); // For EditorHost source mode subscription
  const themeChangeCallbackRef = useRef<((theme: string) => void) | null>(null); // For EditorHost theme change subscription
  const documentModelHandleRef = useRef(documentModelHandle); // For EditorHost to access without recreating

  // Keep DocumentModel handle ref in sync (handle acquired synchronously so this is immediately correct)
  documentModelHandleRef.current = documentModelHandle;

  // State for extension-contributed menu items
  const [extensionMenuItems, setExtensionMenuItems] = useState<Array<{ label: string; icon?: string; onClick: () => void }>>([]);

  // Helper to update pending AI edit state - updates both ref and Jotai atom
  const editorKey = useMemo(() => makeEditorKey(filePath), [filePath]);
  const setPendingAIEditTag = useCallback((tag: {tagId: string, sessionId: string, filePath: string} | null) => {
    pendingAIEditTagRef.current = tag;
    // Update Jotai atom so tab indicator subscribes to it
    store.set(editorHasUnacceptedChangesAtom(editorKey), tag !== null);
  }, [editorKey]);

  // Refs for EditorHost stability - these allow editorHost to access current values without recreating
  const themeRef = useRef(theme);
  const isActiveRef = useRef(isActive);
  const sourceModeRef = useRef(sourceMode);
  // Whether current editor supports source mode toggle (markdown or custom editors that declare it)
  const supportsSourceModeRef = useRef(isMarkdown || customEditorSupportsSourceMode);

  // CRITICAL: Update themeRef SYNCHRONOUSLY during render, not in an effect.
  // Effects run AFTER render, so custom editors would get the stale value if we used an effect.
  // This ensures host.theme returns the current value immediately.
  themeRef.current = theme;

  // NOTE: The old "check disk content on tab activation" polling logic has been removed.
  // File watchers are now active for all open tabs, so changes are detected in real-time
  // via the 'file-changed-on-disk' event handler below. This eliminates the redundant
  // "File Changed While Inactive" dialog that would appear on tab switch.

  // Helper function to fetch session info for diff approval bar
  const fetchDiffSessionInfo = useCallback(async (sessionId: string, editedAt?: number) => {
    try {
      // Try to load session info
      if (window.electronAPI?.aiLoadSession) {
        const sessionData = await window.electronAPI.aiLoadSession(sessionId, workspaceId);
        if (sessionData) {
          setDiffSessionInfo({
            sessionId,
            sessionTitle: sessionData.title || 'AI Session',
            editedAt: editedAt || Date.now(),
            provider: sessionData.provider
          });
          return;
        }
      }
    } catch (error) {
      logger.ui.warn('[TabEditor] Failed to fetch session info for diff bar:', error);
    }
    // Fallback - just set session ID without title
    setDiffSessionInfo({
      sessionId,
      editedAt: editedAt || Date.now()
    });
  }, [workspaceId]);

  // Handler for "Go to Session" button
  const handleGoToSession = useCallback((sessionId: string) => {
    if (onOpenSessionInChat) {
      onOpenSessionInChat(sessionId);
    }
  }, [onOpenSessionInChat]);

  // Notify custom editors of theme changes (themeRef is updated synchronously above)
  useEffect(() => {
    if (themeChangeCallbackRef.current) {
      themeChangeCallbackRef.current(theme);
    }
  }, [theme]);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { sourceModeRef.current = sourceMode; }, [sourceMode]);
  useEffect(() => { supportsSourceModeRef.current = isMarkdown || customEditorSupportsSourceMode; }, [isMarkdown, customEditorSupportsSourceMode]);

  // Clear Lexical editor selection when tab becomes inactive
  // This ensures no stale visual selection when switching back to the tab
  // Note: Monaco handles this internally via the isActive prop
  useEffect(() => {
    if (!isActive && isEditorReady && editorRef.current) {
      // Clear Lexical editor selection
      if (isMarkdown && !sourceMode) {
        const editor = editorRef.current;
        if (editor?.update) {
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              // Collapse selection to start (removes visual selection)
              selection.anchor.set(selection.anchor.key, selection.anchor.offset, selection.anchor.type);
              selection.focus.set(selection.anchor.key, selection.anchor.offset, selection.anchor.type);
            }
          }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
        }
      }
    }
  }, [isActive, isEditorReady, isMarkdown, sourceMode]);

  // Track text selection for AI context
  // This updates window globals when user selects text in the editor
  // Important: We only UPDATE selection when user selects text, but we DON'T clear it
  // when focus leaves the editor (so user can select text, then click into AI chat)
  useEffect(() => {
    // Clear selection when tab becomes inactive (switching to different file)
    if (!isActive) {
      clearTextSelection();
      return undefined;
    }

    // Wait for editor to be ready
    if (!isEditorReady || !editorRef.current) {
      return undefined;
    }

    // Debounce timer for selection updates
    let debounceTimer: NodeJS.Timeout | null = null;

    // For Lexical editor (markdown in rich text mode)
    if (isMarkdown && !sourceMode) {
      const editor = editorRef.current;
      if (editor?.registerUpdateListener) {
        // When tab becomes active, clear any stale selection state
        // The Lexical SelectionAlwaysOnDisplay plugin may show a visual selection,
        // but we want a clean slate - user must re-select to use "+ selection" feature
        clearTextSelection();

        const unregister = editor.registerUpdateListener(() => {
          // Only update selection if the editor has focus
          // This prevents clearing selection when user clicks into AI chat
          const editorElement = editor.getRootElement();
          const hasFocus = editorElement?.contains(document.activeElement) ||
                           document.activeElement === editorElement;

          if (!hasFocus) {
            // Editor doesn't have focus - don't update selection state
            return;
          }

          // Clear any pending debounce
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }

          // Debounce selection updates to reduce performance impact
          debounceTimer = setTimeout(() => {
            editor.getEditorState().read(() => {
              const selection = $getSelection();
              if ($isRangeSelection(selection) && !selection.isCollapsed()) {
                const selectedText = selection.getTextContent();
                if (selectedText && selectedText.trim().length > 0) {
                  setTextSelection(selectedText, filePath);
                } else {
                  clearTextSelection();
                }
              } else {
                // User clicked in editor without selection - clear it
                clearTextSelection();
              }
            });
          }, 150); // 150ms debounce
        });
        return () => {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          unregister();
          clearTextSelection();
        };
      }
      return undefined;
    }

    // For Monaco editor (code files or markdown/custom editor in source mode)
    if (!isMarkdown || sourceMode) {
      const monacoEditor = editorRef.current?.editor;
      if (monacoEditor?.onDidChangeCursorSelection) {
        // When tab becomes active, clear any stale selection state
        clearTextSelection();

        const disposable = monacoEditor.onDidChangeCursorSelection(() => {
          // Only update selection if the editor has focus
          const hasFocus = monacoEditor.hasTextFocus();

          if (!hasFocus) {
            // Editor doesn't have focus - don't update selection state
            return;
          }

          // Clear any pending debounce
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }

          // Debounce selection updates to reduce performance impact
          debounceTimer = setTimeout(() => {
            const selection = monacoEditor.getSelection();
            if (selection && !selection.isEmpty()) {
              const model = monacoEditor.getModel();
              if (model) {
                const selectedText = model.getValueInRange(selection);
                if (selectedText && selectedText.trim().length > 0) {
                  setTextSelection(selectedText, filePath);
                } else {
                  clearTextSelection();
                }
              }
            } else {
              // User clicked in editor without selection - clear it
              clearTextSelection();
            }
          }, 150); // 150ms debounce
        });
        return () => {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          disposable.dispose();
          clearTextSelection();
        };
      }
    }
    return undefined;
  }, [isActive, isEditorReady, isMarkdown, sourceMode, filePath]);

  // CRITICAL FIX RC7: On component mount or file path change, check if there are pending AI edits
  // that should show diffs. This handles the case where a tab is closed and reopened.
  // Only restore diffs for tags that haven't been reviewed/approved yet.
  // MERGED WITH MOUNT DIFF APPLICATION: Consolidated into a single effect that both
  // restores the tag ref AND applies the diff in one operation to prevent flashing.
  const hasCheckedForPendingTagsRef = useRef(false);
  const mountEffectHandledPendingDiffRef = useRef(false); // Track if mount effect found pending diffs

  useEffect(() => {
    // Guard against re-running this effect - only run once per filePath change
    if (hasCheckedForPendingTagsRef.current) return;
    if (!window.electronAPI?.history) return;
    // Wait for editor to be ready before checking pending diffs
    if (!isEditorReady) return;
    if (!editorRef.current && !isCustom) return;
    // Skip pending diff check when in source mode - source mode is for raw editing
    if (sourceMode) return;

    hasCheckedForPendingTagsRef.current = true;
    // Reset the flag for this file
    mountEffectHandledPendingDiffRef.current = false;

    const checkAndApplyPendingDiffs = async () => {
      const tCheckStart = performance.now();
      // For custom editors, wait a tick for their useEffect to register diff callbacks
      // This ensures diffRequestCallbackRef is set before we try to use it
      if (isCustom) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      try {
        const tGetPendingStart = performance.now();
        const pendingTags = await window.electronAPI.history.getPendingTags(filePath);
        console.log(`[TabEditor.timing] getPendingTags: ${(performance.now() - tGetPendingStart).toFixed(1)}ms`);
        if (!pendingTags || pendingTags.length === 0) {
          return;
        }

        // Filter out tags that have been reviewed - only show diffs for pending/unreviewed tags
        const unreviewedTags = pendingTags.filter((tag: any) => tag.status !== 'reviewed' && tag.status !== 'rejected');

        if (unreviewedTags.length === 0) {
          return;
        }

        // CRITICAL: Mark that mount effect found pending diffs IMMEDIATELY after we know they exist
        // This flag prevents the tab activation effect (300ms delay) from also applying the same diff
        // Must be set before any await statements that could delay it
        mountEffectHandledPendingDiffRef.current = true;

        const pendingTag = unreviewedTags[0];

        // Get the baseline for diff comparison
        // This will be the latest incremental-approval tag if it exists, otherwise the pre-edit tag
        const tBaselineStart = performance.now();
        const baseline = await window.electronAPI.invoke('history:get-diff-baseline', filePath);
        console.log(`[TabEditor.timing] get-diff-baseline: ${(performance.now() - tBaselineStart).toFixed(1)}ms`);
        const oldContent = baseline ? baseline.content : pendingTag.content;
        const newContent = contentRef.current; // Use current content ref to get actual disk content

        console.log(`[TabEditor.timing] oldContentLen=${oldContent?.length} newContentLen=${newContent?.length}`);

        logger.ui.info(`[TabEditor] Restoring pending AI edit on mount: tagId=${pendingTag.id}, status=${pendingTag.status}`);
        logger.ui.info(`[TabEditor] Diff content check: oldContentLength=${oldContent?.length}, newContentLength=${newContent?.length}, baseline=${!!baseline}, pendingTagContent=${pendingTag.content?.length}`);

        // If content differs, apply the diff
        if (oldContent !== newContent) {
          // Route through EditorHost callback if custom editor has subscribed to diff requests
          if (diffRequestCallbackRef.current) {
            // Set the ref so other parts of the component know we're in diff mode
            setPendingAIEditTag({
              tagId: pendingTag.id,
              sessionId: pendingTag.sessionId,
              filePath: filePath
            });
            setShowCustomEditorDiffBar(true);
            // Fetch session info for the diff approval bar
            fetchDiffSessionInfo(pendingTag.sessionId, pendingTag.createdAt ? new Date(pendingTag.createdAt).getTime() : Date.now());
            diffRequestCallbackRef.current({
              originalContent: oldContent,
              modifiedContent: newContent,
              tagId: pendingTag.id,
              sessionId: pendingTag.sessionId,
            });
            contentRef.current = oldContent;
            initialContentRef.current = oldContent;
            isDirtyRef.current = false;
            onDirtyChange?.(false);
            return;
          }

          // Custom editors that don't support diff mode: skip diff mode entirely
          // The new content is already on disk, just don't enter diff mode
          if (isCustom) {
            logger.ui.info(`[TabEditor] Custom editor doesn't support diff mode, skipping: ${fileName}`);
            return;
          }

          // Set the ref so other parts of the component know we're in diff mode
          setPendingAIEditTag({
            tagId: pendingTag.id,
            sessionId: pendingTag.sessionId,
            filePath: filePath
          });

          // For code files, use Monaco diff mode
          if (!isMarkdown) {
            logger.ui.info(`[TabEditor] Applying Monaco diff mode for code file on mount`);
            if (editorRef.current.showDiff) {
              editorRef.current.showDiff(oldContent, newContent);
              setShowMonacoDiffBar(true);
              // Fetch session info for the diff approval bar
              fetchDiffSessionInfo(pendingTag.sessionId, pendingTag.createdAt ? new Date(pendingTag.createdAt).getTime() : Date.now());
            } else {
              logger.ui.warn(`[TabEditor] Monaco editor doesn't have showDiff method`);
            }
            return;
          }

          // For markdown files, use Lexical diff mode.
          // Skip it for oversize payloads: the TOPT tree-matcher in
          // applyMarkdownDiffToDocument is O(N^2) in root-children count and
          // hits V8's Map size cap (~16M entries) on documents with >~1500
          // root nodes. On a real CHANGELOG-shaped 280KB-vs-413KB pending
          // diff this pins the renderer for ~57s before throwing a swallowed
          // "Map maximum size exceeded" error. Until we rewrite the matcher
          // (see nimbalyst-local/plans/lexical-diff-size-guard.md) we bail
          // out before entering the slow path. The pendingAIEditTag is
          // already set above, so the approval bar still appears and the
          // user can accept/reject from there -- they just don't get the
          // inline diff highlighting for this one file.
          const LEXICAL_DIFF_MAX_BYTES = 200_000;
          if (
            (oldContent?.length ?? 0) > LEXICAL_DIFF_MAX_BYTES ||
            (newContent?.length ?? 0) > LEXICAL_DIFF_MAX_BYTES
          ) {
            logger.ui.warn(
              `[TabEditor] Skipping Lexical diff on mount for oversize payload: ` +
                `oldLen=${oldContent?.length ?? 0} newLen=${newContent?.length ?? 0} ` +
                `threshold=${LEXICAL_DIFF_MAX_BYTES} file=${fileName}`,
            );
            fetchDiffSessionInfo(
              pendingTag.sessionId,
              pendingTag.createdAt ? new Date(pendingTag.createdAt).getTime() : Date.now(),
            );
            return;
          }

          // Reset editor to old (tagged) content first
          const transformers = getEditorTransformers();

          const tReparseStart = performance.now();
          editorRef.current.update(() => {
            const tInsideUpdateStart = performance.now();
            const root = $getRoot();
            root.clear();
            const tAfterClear = performance.now();
            $convertFromEnhancedMarkdownString(oldContent, transformers);
            const tAfterConvert = performance.now();
            console.log(`[TabEditor.timing]   inside update: clear=${(tAfterClear - tInsideUpdateStart).toFixed(1)}ms convertFromMarkdown=${(tAfterConvert - tAfterClear).toFixed(1)}ms`);
          }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
          console.log(`[TabEditor.timing] clear+reparseOldContent (editor.update wall): ${(performance.now() - tReparseStart).toFixed(1)}ms`);

          contentRef.current = oldContent;

          // Wait a tick before applying diff
          await new Promise(resolve => setTimeout(resolve, 100));

          // Apply the diff
          // Don't pass oldText - let the command handler extract it from the editor
          // This handles normalization differences (tables, spacing, etc.)
          isApplyingDiffRef.current = true;
          try {
            const replacements = [{
              newText: newContent
            }];
            const tDispatchStart = performance.now();
            editorRef.current.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, replacements);
            console.log(`[TabEditor.timing] APPLY_MARKDOWN_REPLACE_COMMAND dispatch: ${(performance.now() - tDispatchStart).toFixed(1)}ms`);
            console.log(`[TabEditor.timing] TOTAL checkAndApplyPendingDiffs: ${(performance.now() - tCheckStart).toFixed(1)}ms`);
            console.log(`[TabEditor] Applied pending AI edit diff on mount`);
            // Fetch session info for the diff approval bar (for Lexical)
            fetchDiffSessionInfo(pendingTag.sessionId, pendingTag.createdAt ? new Date(pendingTag.createdAt).getTime() : Date.now());
          } finally {
            setTimeout(() => {
              isApplyingDiffRef.current = false;

              // Reset dirty state after diff application - user hasn't made any changes
              // This prevents false-positive autosaves from WYSIWYG rendering differences
              isDirtyRef.current = false;
              onDirtyChange?.(false);
            }, 100);
          }
        }
      } catch (error) {
        logger.ui.error(`[TabEditor] Failed to check and apply pending diffs on mount:`, error);
      }
    };

    checkAndApplyPendingDiffs();
  }, [filePath, isMarkdown, isEditorReady, isCustom, sourceMode]); // Wait for editor to be ready before checking pending diffs


  // Helper: Save file with history snapshot
  // skipDiffCheck: Set to true when saving during AI operations (accept/reject/streaming)
  const saveWithHistory = useCallback(async (
      contentToSave: string,
      snapshotType: 'auto' | 'manual' = 'auto',
      skipDiffCheck: boolean = false
  ) => {
    if (!window.electronAPI) return;

    try {
      // Generate a unique save ID to track this specific save operation
      const thisSaveId = ++saveIdRef.current;
      pendingSaveIdsRef.current.add(thisSaveId);

      // Capture the content we expect to be on disk BEFORE we optimistically
      // overwrite lastSavedContentRef. This becomes the `lastKnownContent`
      // baseline for the IPC's conflict check: if disk contains anything
      // else, we know an external process changed the file (e.g. an AI
      // session recreated a previously-deleted file). For autosave, the
      // conflict path preserves the buffer rather than clobbering disk.
      const expectedDiskContent = lastSavedContentRef.current;

      // Set saving flag BEFORE saving to prevent file watcher from reloading
      isSavingRef.current = true;

      // Update refs BEFORE saving so file watcher can detect it's our own save
      // CRITICAL: Update both ref and state synchronously to ensure file watcher sees the change
      const saveTime = Date.now();
      lastSaveTimeRef.current = saveTime;
      lastSavedContentRef.current = contentToSave;

      // Update DocumentModel echo-suppression baseline BEFORE writing to disk.
      // The file watcher can fire before saveFile returns, and echo suppression
      // needs to see the new content as "ours" to avoid unnecessary getPendingTags calls.
      documentModel?.setLastPersistedContent(contentToSave);

      logger.ui.info(`[TabEditor] Saving ${fileName}, saveId=${thisSaveId}, skipDiffCheck=${skipDiffCheck}`);

      // Save to disk with conflict detection. Always pass lastKnownContent so
      // the main process can detect external changes and refuse to overwrite
      // them silently.
      const result = await window.electronAPI.saveFile(
          contentToSave,
          filePath,
          expectedDiskContent
      );

      // console.log(`[TabEditor] saveFile returned for ${fileName}, success=${result?.success}, conflict=${result?.conflict}`);

      // IMMEDIATE: Clear dirty flag as soon as save succeeds
      if (result && result.success) {
        isDirtyRef.current = false;
        documentModelHandleRef.current?.setDirty(false);
        // Notify clean sibling editors (e.g. same file open in AgentMode)
        documentModelHandleRef.current?.notifySiblingsSaved(contentToSave);
        // Update initialContentRef with current editor content to prevent false dirty flags
        if (getContentFnRef.current) {
          initialContentRef.current = getContentFnRef.current();
        }
        // Notify parent immediately
        onDirtyChange?.(false);
        // console.log(`[TabEditor] Cleared dirty flag immediately after successful save for ${fileName}`);
      }

      if (result) {
        // Check for conflicts
        if (result.conflict) {
          // Restore lastSavedContentRef -- we optimistically set it to
          // contentToSave above, but the save did NOT land on disk. The
          // baseline must remain whatever we last knew was on disk so the
          // next conflict check is meaningful.
          lastSavedContentRef.current = expectedDiskContent;

          if (snapshotType === 'auto') {
            // Autosave path: never overwrite silently, never prompt. Show a
            // non-blocking banner. Buffer is preserved as-is. The user can
            // click "Reload" to pick up disk content. Until then, autosave
            // skips because lastSavedContentRef still mismatches disk on
            // every retry; the banner stays up.
            logger.ui.info('[TabEditor] Autosave conflict detected -- showing non-blocking banner, buffer preserved');
            if (typeof result.diskContent === 'string') {
              setAutosaveConflictDiskContent(result.diskContent);
            } else {
              setAutosaveConflictDiskContent('');
            }
            // Keep the buffer dirty so the user's edits are preserved.
            // Don't proceed to history snapshot for this failed save.
            return;
          }

          // Manual save path: prompt the user as before.
          logger.ui.info('[TabEditor] Save conflict detected, prompting user');
          const shouldOverwrite = window.confirm(
              'The file has been modified externally since you opened it.\n\n' +
              'Do you want to overwrite the external changes with your edits?\n\n' +
              'Click OK to overwrite, or Cancel to reload the file from disk.'
          );

          if (shouldOverwrite) {
            // Retry save without conflict checking (force overwrite)
            const forceResult = await window.electronAPI.saveFile(contentToSave, filePath);
            if (forceResult && forceResult.success) {
              initialContentRef.current = contentToSave;
              lastSaveTimeRef.current = Date.now();
              lastSavedContentRef.current = contentToSave;
            }
          } else if (result.diskContent) {
            // User chose to reload - update editor with disk content
            // Update editor content programmatically to avoid remount
            const diskContent = result.diskContent;
            if (editorRef.current) {
              try {
                // Import Lexical functions from 'lexical' and editor functions from '@nimbalyst/runtime'
                const transformers = getEditorTransformers();

                editorRef.current.update(() => {
                  const root = $getRoot();
                  root.clear();
                  $convertFromEnhancedMarkdownString(diskContent, transformers);
                }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
              } catch (error) {
                logger.ui.error(`[TabEditor] Failed to update editor content:`, error);
              }
            }

            contentRef.current = diskContent;
            initialContentRef.current = diskContent;
            lastSavedContentRef.current = diskContent;
            isDirtyRef.current = false;
            return;
          }
        }

        // Create history snapshot
        if (window.electronAPI.history) {
          try {
            const description = snapshotType === 'manual' ? 'Manual save' : 'Auto-save';
            const dbSnapshotType = snapshotType === 'manual' ? 'manual' : 'auto-save';
            await window.electronAPI.history.createSnapshot(
                result.filePath,
                contentToSave,
                dbSnapshotType,
                description
            );
          } catch (error) {
            logger.ui.error(`[TabEditor] Failed to create history snapshot for ${filePath}:`, error);
          }
        }

        // Check if we should clear pending-review tags after save.
        // Only for user-initiated saves (skipDiffCheck=false), not AI operations.
        // Only for Lexical editors that have getEditorState.
        if (!skipDiffCheck && editorRef.current && typeof editorRef.current.getEditorState === 'function') {
          const hasDiffs = editorRef.current.getEditorState().read(() => {
            return $hasDiffNodes(editorRef.current!);
          });

          if (!hasDiffs) {
            // Clear from ref if set
            if (pendingAIEditTagRef.current?.tagId) {
              logger.ui.info('[TabEditor] No diffs remaining after user save, clearing pending tag');
              const { tagId, filePath: tagFilePath } = pendingAIEditTagRef.current;
              await window.electronAPI.invoke('history:update-tag-status', tagFilePath, tagId, 'reviewed');
              setPendingAIEditTag(null);
              // Exclude self: clearDiffState fans out to siblings via
              // onDiffResolved; recursing back into our own subscription
              // would re-clear the (already-cleared) tag state.
              documentModel?.clearDiffState(documentModelHandleRef.current?.id, true);
            } else if (window.electronAPI?.history) {
              // Also check database for pending tags (may exist from simulateApplyDiff path
              // where the tag was created in DB but pendingAIEditTagRef was never set)
              try {
                const dbTags = await window.electronAPI.history.getPendingTags(filePath);
                const unreviewedTags = (dbTags || []).filter((t: any) => t.status !== 'reviewed' && t.status !== 'rejected');
                for (const tag of unreviewedTags) {
                  await window.electronAPI.invoke('history:update-tag-status', filePath, tag.id, 'reviewed');
                }
              } catch {
                // Ignore -- best effort cleanup
              }
            }
          }
        }

        // Notify parent
        onSaveComplete?.(result.filePath);

        // Clear this save ID after a delay to ensure file watcher events are processed
        // File watchers can be slow, especially on macOS, so use a generous timeout
        setTimeout(() => {
          pendingSaveIdsRef.current.delete(thisSaveId);
          // Only clear isSaving if no pending saves
          if (pendingSaveIdsRef.current.size === 0) {
            isSavingRef.current = false;
          }
        }, 10000);
      }
    } catch (error) {
      logger.ui.error(`[TabEditor] Failed to save file ${filePath}:`, error);
      // Reset refs on error
      lastSaveTimeRef.current = null;
      lastSaveTimeRef.current = null;
      isSavingRef.current = false;
      throw error;
    }
  }, [filePath, fileName, onSaveComplete]);

  // Latest saveWithHistory accessible from the stable EditorHost adapter (which
  // is memoized on filePath/fileName and would otherwise capture a stale closure).
  // The host adapter routes built-in editor saves through this ref so they
  // participate in Layer D conflict detection like saveWithHistory does directly.
  const saveWithHistoryRef = useRef(saveWithHistory);
  useEffect(() => {
    saveWithHistoryRef.current = saveWithHistory;
  }, [saveWithHistory]);

  // Manual save function
  const handleManualSave = useCallback(async () => {
    if (!getContentFnRef.current) {
      logger.ui.warn('[TabEditor] No getContent function available for manual save');
      return;
    }

    // If in diff mode (e.g. tab being closed), approve all diffs first so we
    // save clean content without diff markers. This prevents data loss when
    // the user closes a tab or the app quits while diffs are showing.
    // We call $approveDiffs directly (not via command) to avoid triggering the
    // CLEAR_DIFF_TAG_COMMAND chain which would double-save.
    if (pendingAIEditTagRef.current && editorRef.current && typeof editorRef.current.update === 'function') {
      logger.ui.info(`[TabEditor] Approving diffs before manual save for ${fileName}`);
      editorRef.current.update(() => {
        $approveDiffs();
      });
      // Clear the pending tag since we've accepted everything. Exclude self
      // from the fan-out so onDiffResolved doesn't recurse into our own editor.
      documentModel?.clearDiffState(documentModelHandleRef.current?.id, true);
      const { tagId, filePath: tagFilePath } = pendingAIEditTagRef.current;
      window.electronAPI.invoke('history:update-tag-status', tagFilePath, tagId, 'reviewed');
      setPendingAIEditTag(null);
    }

    const currentContent = getContentFnRef.current();
    // Use skipDiffCheck=false so saveWithHistory checks for leftover diff nodes
    // and clears pending tags if all diffs have been resolved
    await saveWithHistory(currentContent, 'manual', false);
  }, [saveWithHistory, fileName]);

  // Periodic snapshots
  const lastSnapshotContentRef = useRef<string>(initialContent);

  useEffect(() => {
    if (!window.electronAPI?.history || periodicSnapshotInterval <= 0) return;

    const timer = setInterval(async () => {
      if (!getContentFnRef.current) return;

      // Skip periodic snapshots if we're in diff mode
      if (pendingAIEditTagRef.current) {
        logger.ui.info(`[TabEditor] Skipping periodic snapshot - diff mode active for ${fileName}`);
        return;
      }

      try {
        const currentContent = getContentFnRef.current();
        const lastContent = lastSnapshotContentRef.current;

        // Only create snapshot if content changed since last periodic snapshot
        if (currentContent && currentContent !== lastContent && currentContent !== '') {
          logger.ui.info(`[TabEditor] Creating periodic snapshot for: ${fileName}`);
          await window.electronAPI.history.createSnapshot(
              filePath,
              currentContent,
              'auto-save',
              'Periodic auto-save'
          );
          lastSnapshotContentRef.current = currentContent;
        }
      } catch (error) {
        logger.ui.error(`[TabEditor] Failed to create periodic snapshot for ${fileName}:`, error);
      }
    }, periodicSnapshotInterval);

    return () => clearInterval(timer);
  }, [periodicSnapshotInterval, filePath, fileName]);

  // ============================================================
  // DocumentModel integration for built-in editors (Lexical/Monaco)
  //
  // Register autosave and file-change callbacks with the DocumentModel handle.
  // This replaces the old autosave timer and file-watcher IPC listener for
  // ALL editor types (built-in + custom), providing a single coordination
  // point for save timing, echo suppression, and diff mode detection.
  //
  // CRITICAL: gated on isEditorReady. When a sibling tab system (e.g.
  // EditorMode + Agent Mode WorkstreamEditorTabs) opens the same file, the
  // shared DocumentModel may already be carrying a `diffState` from the
  // first attachment's handling of an AI edit. `onDiffRequested` fires the
  // current `diffState` synchronously to a new subscriber, so registering
  // before the editor mounts means `applyDiffState` runs with
  // `editorRef.current === null`: no diff renders, but `contentRef.current`
  // gets overwritten with `oldContent`, which then makes the mount-time
  // pending-tag check (line ~515) skip because `oldContent === newContent`.
  // Deferring registration to `isEditorReady` ensures the immediate-fire
  // happens with a ready editor.
  // ============================================================
  useEffect(() => {
    const handle = documentModelHandleRef.current;
    if (!handle) return;
    // Wait for the editor to mount before registering. See note above.
    if (!isEditorReady) return;

    const cleanups: Array<() => void> = [];

    // --- Autosave: DocumentModel calls onSaveRequested when it's time to save ---
    // Custom editors wire their own callback via EditorHost.subscribeToSaveRequests.
    // This handler covers built-in editors (Lexical/Monaco) that use getContentFnRef.
    // If a custom editor has already registered via EditorHost, skip (checked at call time).
    cleanups.push(
      handle.onSaveRequested(() => {
        // Custom editors handle their own save via EditorHost callback
        if (editorHostSaveRequestCallbackRef.current) return;
        // Skip if no content function (editor not ready)
        if (!getContentFnRef.current) return;
        // Skip if applying a diff
        if (isApplyingDiffRef.current) return;

        // If in diff mode, check if all diffs have been manually resolved.
        // (User may have deleted all diff content via select-all + backspace.)
        // If no diff nodes remain, clear the pending tag so autosave can proceed.
        if (pendingAIEditTagRef.current && editorRef.current && typeof editorRef.current.getEditorState === 'function') {
          const hasDiffs = editorRef.current.getEditorState().read(() => {
            return $hasDiffNodes(editorRef.current!);
          });
          if (hasDiffs) return; // Still has diffs, skip autosave
          // All diffs resolved manually -- clear tag and fall through to save
          logger.ui.info(`[TabEditor] No diffs remaining, clearing pending tag: ${fileName}`);
          const { tagId, filePath: tagFilePath } = pendingAIEditTagRef.current;
          window.electronAPI.invoke('history:update-tag-status', tagFilePath, tagId, 'reviewed');
          setPendingAIEditTag(null);
          // Exclude self from the diffResolved fan-out -- siblings still
          // need to exit diff mode, but we already did our local cleanup.
          documentModel?.clearDiffState(documentModelHandleRef.current?.id, true);
        }

        const currentContent = getContentFnRef.current();
        logger.ui.info(`[TabEditor] DocumentModel autosave: ${fileName}`);
        saveWithHistory(currentContent, 'auto').catch((err) => {
          logger.ui.error(`[TabEditor] DocumentModel autosave failed for ${filePath}:`, err);
        });
      }),
    );

    // --- File changes: DocumentModel calls onFileChanged for non-diff external edits ---
    // Custom editors receive file changes through EditorHost.subscribeToFileChanges(),
    // which registers its own onFileChanged callback with the handle. This callback
    // only handles built-in editors (Lexical/Monaco).
    cleanups.push(
      handle.onFileChanged((content) => {
        if (typeof content !== 'string') return;

        diffTrace('TabEditor.onFileChanged fired', {
          filePath,
          isCustom,
          isMarkdown,
          contentLen: content.length,
          contentHead: content.slice(0, 80),
          sameAsLastSaved: content === lastSavedContentRef.current,
          isApplyingDiff: isApplyingDiffRef.current,
          hasPendingTag: !!pendingAIEditTagRef.current,
          t: performance.now(),
        });

        // Custom editors are notified via EditorHost.subscribeToFileChanges (separate subscription).
        if (isCustom) return;

        // Guard: don't clobber the editor's content while a diff is being applied
        // (the onDiffRequested handler resets to oldContent then waits 250ms before
        // dispatching the replacement; a racing onFileChanged would replace the
        // pre-edit content with post-edit content, leaving additions unmarked).
        // Also bail if a pending AI edit tag is already tracked for this tab —
        // diff resolution will route the final content through notifyFileChanged.
        if (isApplyingDiffRef.current || pendingAIEditTagRef.current) {
          diffTrace('TabEditor.onFileChanged SKIP (diff in flight)', {
            filePath,
            isApplyingDiff: isApplyingDiffRef.current,
            hasPendingTag: !!pendingAIEditTagRef.current,
            t: performance.now(),
          });
          return;
        }

        // Skip if content is identical to what we already have.
        // This prevents unnecessary Lexical reloads that destroy cursor position
        // (e.g. when a sibling saves content we already have).
        if (content === lastSavedContentRef.current) return;

        diffTrace('TabEditor.onFileChanged WILL REPLACE editor content', {
          filePath,
          isApplyingDiff: isApplyingDiffRef.current,
          t: performance.now(),
        });

        // Guard: suppress the Lexical onChange -> setDirty(true) that fires
        // from the programmatic content update below.
        isApplyingExternalContentRef.current = true;

        if (editorRef.current) {
          try {
            if (isMarkdown) {
              const transformers = getEditorTransformers();
              editorRef.current.update(() => {
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(content, transformers);
              }, { tag: externalContentUpdateTags(editorRef.current) });
            } else if (editorRef.current.setContent) {
              editorRef.current.setContent(content);
            }
            setReloadVersion((v) => v + 1);
          } catch (error) {
            logger.ui.error(`[TabEditor] Failed to apply DocumentModel file change:`, error);
          }
        }

        contentRef.current = content;
        lastSavedContentRef.current = content;
        initialContentRef.current = content;
        isDirtyRef.current = false;
        onDirtyChange?.(false);

        setTimeout(() => {
          isApplyingExternalContentRef.current = false;
        }, 0);
      }),
    );

    // --- Diff mode: DocumentModel calls onDiffRequested only when there's new work ---
    //
    // DocumentModel runs the DiffSession state machine. It only fires onDiffRequested
    // when the session transitions to `applying` with a fresh payload. Duplicates and
    // in-flight queues are handled inside the model -- we just apply whatever shows up.
    // After the editor finishes its replay we call `handle.markDiffApplied()` so the
    // model can transition to `applied` and drain any payload that arrived during the
    // apply (the model will fire onDiffRequested again with the drained content).
    const applyDiffState = async (state: DiffState): Promise<void> => {
      const { tagId, sessionId, oldContent, newContent, createdAt } = state;
      const tagInfo = { tagId, sessionId, filePath };

      isApplyingDiffRef.current = true;
      setPendingAIEditTag(tagInfo);

      try {
        if (diffRequestCallbackRef.current) {
          // Custom editor with declared diff view
          setShowCustomEditorDiffBar(true);
          fetchDiffSessionInfo(sessionId, createdAt);
          diffRequestCallbackRef.current({
            originalContent: oldContent,
            modifiedContent: newContent,
            tagId,
            sessionId,
          });
          contentRef.current = oldContent;
          initialContentRef.current = oldContent;
          isDirtyRef.current = false;
          onDirtyChange?.(false);
          setReloadVersion((v) => v + 1);
        } else if (isCustom && !customEditorSupportsDiffMode) {
          // Custom editor with no diff view: auto-accept so subsequent external edits flow
          // through notifyFileChanged instead of being swallowed by diff-mode routing.
          contentRef.current = newContent;
          initialContentRef.current = newContent;
          lastSavedContentRef.current = newContent;
          isDirtyRef.current = false;
          onDirtyChange?.(false);
          try {
            await handle.resolveDiff(true);
          } catch (err) {
            logger.ui.error('[TabEditor] Auto-accept diff failed for no-diff-view custom editor:', err);
          }
        } else {
          // Built-in editor: Lexical or Monaco
          contentRef.current = oldContent;

          if (editorRef.current) {
            if (isMarkdown) {
              const transformers = getEditorTransformers();
              diffTrace('TabEditor.applyDiffState resetting editor to oldContent', { filePath, oldLen: oldContent.length, t: performance.now() });
              editorRef.current.update(() => {
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(oldContent, transformers);
              }, { tag: externalContentUpdateTags(editorRef.current) });

              await new Promise((resolve) => setTimeout(resolve, 250));

              // Snapshot what's actually in the editor right before we dispatch,
              // to catch races where onFileChanged replaced the content during the wait.
              let preDispatchMarkdown = '';
              try {
                preDispatchMarkdown = editorRef.current.getEditorState().read(() => {
                  return $convertToEnhancedMarkdownString(transformers);
                });
              } catch (err) {
                diffTrace('TabEditor pre-dispatch read failed', err);
              }
              diffTrace('TabEditor.applyDiffState pre-dispatch editor state', {
                filePath,
                preDispatchLen: preDispatchMarkdown.length,
                preDispatchHead: preDispatchMarkdown.slice(0, 80),
                matchesOld: preDispatchMarkdown === oldContent,
                matchesNew: preDispatchMarkdown === newContent,
                t: performance.now(),
              });

              editorRef.current.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, [{ newText: newContent }]);
              fetchDiffSessionInfo(sessionId, createdAt);

              await new Promise((resolve) => setTimeout(resolve, 100));
              diffTrace('TabEditor.applyDiffState post-dispatch settle done', { filePath, t: performance.now() });
            } else if (editorRef.current.showDiff) {
              editorRef.current.showDiff(oldContent, newContent);
              setShowMonacoDiffBar(true);
              fetchDiffSessionInfo(sessionId, createdAt);
            }
          }

          isDirtyRef.current = false;
          onDirtyChange?.(false);
          setReloadVersion((v) => v + 1);
        }
      } catch (error) {
        logger.ui.error(`[TabEditor] Failed to apply DocumentModel diff:`, error);
      } finally {
        isApplyingDiffRef.current = false;
        // Tell the model we're done so it can drain any payload that landed during apply.
        // The model will fire onDiffRequested again if there was queued content.
        try {
          handle.markDiffApplied();
        } catch (err) {
          logger.ui.error('[TabEditor] markDiffApplied failed:', err);
        }
      }
    };

    cleanups.push(
      handle.onDiffRequested((diffState) => {
        const { tagId, oldContent, newContent, newContentHash } = diffState;

        diffTrace('TabEditor.onDiffRequested fired', {
          filePath,
          isCustom,
          isMarkdown,
          tagId,
          newContentHash,
          newLen: typeof newContent === 'string' ? newContent.length : -1,
          newHead: typeof newContent === 'string' ? newContent.slice(0, 80) : '',
          sameOldNew: oldContent === newContent,
          alreadyTrackingTag: pendingAIEditTagRef.current?.tagId === tagId,
          t: performance.now(),
        });

        if (oldContent === newContent) {
          diffTrace('TabEditor.onDiffRequested SKIP empty diff', { filePath, tagId, t: performance.now() });
          // Tell the model the (empty) apply is done so its session doesn't sit in 'applying'.
          handle.markDiffApplied();
          return;
        }

        void applyDiffState(diffState);
      }),
    );

    // --- Sibling diff resolution: another attachment accepted/rejected the diff ---
    // Without this, a file open in both Files mode and Agent mode would stay stuck
    // in diff mode on whichever side did NOT click Approve. We dismiss the local
    // diff UI here; the upcoming notifyFileChanged from the resolving editor
    // delivers the post-resolution content.
    cleanups.push(
      handle.onDiffResolved((accepted) => {
        if (!pendingAIEditTagRef.current) return;
        logger.ui.info('[TabEditor] Sibling editor resolved diff -- exiting diff mode', { filePath, accepted });

        // Drop our local pending-tag tracking. onFileChanged is gated on
        // pendingAIEditTagRef being null, so without this clear the resolved
        // content delivered next would be dropped.
        setPendingAIEditTag(null);

        // Hide the diff approval bar / change-count UI (Monaco path).
        setShowMonacoDiffBar(false);
        setDiffSessionInfo(null);
        setMonacoDiffChangeCount(0);

        // Visually clean up any leftover diff nodes/decorations. We wrap in
        // isApplyingDiffRef so the resulting Lexical updates don't mark the
        // editor dirty.
        if (editorRef.current) {
          isApplyingDiffRef.current = true;
          try {
            if (isMarkdown && typeof editorRef.current.update === 'function') {
              editorRef.current.update(() => {
                if ($hasDiffNodes(editorRef.current!)) {
                  if (accepted) {
                    $approveDiffs();
                  } else {
                    $rejectDiffs();
                  }
                }
              });
            } else if (typeof editorRef.current.exitDiffMode === 'function') {
              // Monaco diff editor
              try {
                editorRef.current.exitDiffMode();
              } catch (err) {
                logger.ui.warn('[TabEditor] exitDiffMode failed for sibling diff resolution:', err);
              }
            }
          } finally {
            // Defer clearing so the Lexical update listener that runs after
            // the editor.update() above has the flag set when it fires.
            setTimeout(() => {
              isApplyingDiffRef.current = false;
            }, 0);
          }
        }
      }),
    );

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileName, isMarkdown, isCustom, saveWithHistory, isEditorReady]);


  // Listen for "Clear All Pending" event to exit diff mode when this file's pending tag is cleared
  useEffect(() => {
    if (!window.electronAPI?.history?.onPendingCleared) {
      return;
    }

    const unsubscribe = window.electronAPI.history.onPendingCleared((data: { workspacePath: string; clearedFiles: string[] }) => {
      // Check if this file was in the list of cleared files
      const normalizedFilePath = normalizePathForCompare(filePath);
      if (data.clearedFiles.some(f => normalizePathForCompare(f) === normalizedFilePath)) {
        if (isClearingDiffTagRef.current) {
          logger.ui.info('[TabEditor] Skipping onPendingCleared reload during local diff clear flow:', filePath);
          return;
        }

        logger.ui.info('[TabEditor] Pending tag cleared for this file, exiting diff mode:', filePath);

        // Clear pending tag ref
        setPendingAIEditTag(null);

        // Hide the diff approval bar and clear session info
        setShowMonacoDiffBar(false);
        setDiffSessionInfo(null);

        // Reload from disk to get the content that was kept (AI already wrote to disk)
        // This is needed for both Monaco and Lexical to sync editor content with disk
        window.electronAPI.readFileContent(filePath).then((result) => {
          if (result?.success && result.content !== undefined) {
            const newContent = result.content;
            contentRef.current = newContent;
            initialContentRef.current = newContent;
            lastSavedContentRef.current = newContent;
            isDirtyRef.current = false;
            onDirtyChange?.(false);

            if (isMarkdown && editorRef.current) {
              // For Lexical (markdown), we need to clear diff nodes and reload content
              const transformers = getEditorTransformers();
              editorRef.current?.update(() => {
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(newContent, transformers);
              }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
            } else if (!isMarkdown && editorRef.current) {
              // For Monaco, exit diff mode and update content
              if (editorRef.current.exitDiffMode) {
                editorRef.current.exitDiffMode();
              }
              // Update Monaco editor content to match what's on disk
              if (editorRef.current.setContent) {
                editorRef.current.setContent(newContent, { force: true });
              }
            }
          }
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [filePath, isMarkdown]);

  // Handle conflict dialog actions
  const handleReloadFromDisk = useCallback(async () => {
    const newContent = conflictDialogContent;
    setShowConflictDialog(false);
    setConflictDialogContent('');

    // Apply the reload
    contentRef.current = newContent;
    initialContentRef.current = newContent;
    lastSavedContentRef.current = newContent;
    isDirtyRef.current = false;
    onDirtyChange?.(false);

    // Update editor content
    if (editorRef.current) {
      try {
        if (isMarkdown) {
          const transformers = getEditorTransformers();

          editorRef.current.update(() => {
            const root = $getRoot();
            root.clear();
            $convertFromEnhancedMarkdownString(newContent, transformers);
          }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
        } else {
          // Update Monaco editor
          if (editorRef.current.setContent) {
            editorRef.current.setContent(newContent);
          }
        }
      } catch (error) {
        logger.ui.error(`[TabEditor] Failed to update editor content:`, error);
      }
    }
  }, [conflictDialogContent, fileName, isMarkdown]);

  const handleKeepLocalChanges = useCallback(() => {
    setShowConflictDialog(false);
    setConflictDialogContent('');
  }, []);

  // Stable callback to get content for DocumentHeaderContainer
  // Uses refs to avoid recreating the callback and causing unnecessary re-renders
  const getDocumentHeaderContent = useCallback((): string => {
    return getContentFnRef.current?.() ?? '';
  }, []);

  // Handle content change from document header
  const handleDocumentHeaderContentChange = useCallback((newContent: string) => {
    // console.log(`[TabEditor] handleDocumentHeaderContentChange called for ${fileName}, newContentLength=${newContent.length}`);
    // console.trace('[TabEditor] DocumentHeader content change stack trace:');

    // Update editor content programmatically
    if (editorRef.current) {
      (async () => {
        try {
          if (isMarkdown) {
            const transformers = getEditorTransformers();

            editorRef.current.update(() => {
              const root = $getRoot();
              root.clear();
              $convertFromEnhancedMarkdownString(newContent, transformers);
            }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
          } else {
            // Update Monaco editor
            if (editorRef.current.setContent) {
              editorRef.current.setContent(newContent);
            }
          }

          // Update working copy ref and mark as dirty so autosave will persist
          contentRef.current = newContent;
          isDirtyRef.current = true;
          documentModelHandleRef.current?.setDirty(true);

          // Notify parent that content changed and is dirty
          onDirtyChange?.(true);
        } catch (error) {
          logger.ui.error(`[TabEditor] Failed to update content from document header:`, error);
        }
      })();
    }
  }, [isMarkdown]);

  // PHASE 5: Listen for diff approve/reject commands to update tag status
  useEffect(() => {
    if (!editorRef.current) return;

    const editor = editorRef.current;

    // NOTE: handleApprove and handleReject have been removed.
    // APPROVE_DIFF_COMMAND and REJECT_DIFF_COMMAND are now handled solely by DiffPlugin.
    // TabEditor only handles CLEAR_DIFF_TAG_COMMAND which is dispatched by DiffPlugin after all diffs are processed.

    // Handle incremental approval - create tag for partial accept/reject
    const handleIncrementalApproval = async () => {
      try {
        if (!pendingAIEditTagRef.current) {
          return;
        }

        const { tagId, sessionId, filePath } = pendingAIEditTagRef.current;

        // Get current editor content (includes the accepted/rejected changes)
        if (editorRef.current) {
          const transformers = getEditorTransformers();

          // Get the APPROVED content (normal export - what's actually in the editor)
          const approvedContent = editorRef.current.getEditorState().read(() => {
            return $convertToEnhancedMarkdownString(transformers);
          });

          // Get the REJECTED content (what-if we rejected all remaining diffs)
          // This becomes the baseline for comparing remaining diffs
          const rejectedContent = editorRef.current.getEditorState().read(() => {
            return $convertToEnhancedMarkdownString(transformers, { rejectMode: true });
          });

          // Save the approved content to disk
          await window.electronAPI.saveFile(approvedContent, filePath);

          // Create incremental-approval tag with the REJECTED version
          // This is the baseline: it shows what we've decided so far (approved + rejected)
          const newTagId = await window.electronAPI.invoke('history:create-incremental-approval-tag',
            filePath,
            rejectedContent,
            sessionId,
            {}  // Can optionally track which groups were accepted/rejected
          );

          logger.ui.info(`[TabEditor] Created incremental-approval tag for session: ${sessionId}, tagId: ${newTagId}`);

          // Advance the Codex cache so subsequent edits use the approved state as baseline
          window.electronAPI.invoke('ai:advance-diff-baseline', sessionId, filePath, approvedContent);

          // CRITICAL: Update pendingAIEditTagRef to point to the NEW incremental-approval tag
          // This ensures that when CLEAR_DIFF_TAG_COMMAND is dispatched later, it marks the correct tag as reviewed
          setPendingAIEditTag({
            tagId: newTagId,
            sessionId,
            filePath
          });

          // Tell DocumentModel about the rotation so its DiffSession re-baselines onto the new
          // tag and the next file-watcher event diffs against the post-partial state.
          documentModelHandleRef.current?.completePartialResolve({
            newTagId,
            newBaseline: rejectedContent,
          });

          // Update our state
          contentRef.current = approvedContent;
          lastSavedContentRef.current = approvedContent;
        }
      } catch (error) {
        logger.ui.error('[TabEditor] Failed to create incremental-approval tag:', error);
      }
    };

    // Handle clearing diff tag without accept/reject (for incremental operations)
    const handleClearDiffTag = async () => {
      isClearingDiffTagRef.current = true;
      try {
        if (!pendingAIEditTagRef.current) {
          logger.ui.warn('[TabEditor] handleClearDiffTag called but no pendingAIEditTagRef');
          return;
        }

        const { tagId, sessionId: clearSessionId, filePath } = pendingAIEditTagRef.current;
        logger.ui.info('[TabEditor] handleClearDiffTag START:', { tagId, filePath });

        // CRITICAL: Mark tag as reviewed BEFORE saving to disk
        // This prevents the file watcher from re-entering diff mode when it detects the save
        await window.electronAPI.history.updateTagStatus(filePath, tagId, 'reviewed', workspaceId);
        logger.ui.info(`[TabEditor] Successfully marked AI edit tag as reviewed: ${tagId}`);

        // Clear the pending tag reference immediately so file watcher won't re-enter diff mode
        setPendingAIEditTag(null);

        // Clear DocumentModel's diff state AND fan out to sibling attachments
        // so they dismiss their own diff UI. Without excluding our own editor
        // id we'd recurse via the onDiffResolved callback we just registered.
        documentModel?.clearDiffState(documentModelHandleRef.current?.id, true);

        // Now save current editor state to disk
        if (editorRef.current) {
            const transformers = getEditorTransformers();

            const currentContent = editorRef.current.getEditorState().read(() => {
              return $convertToEnhancedMarkdownString(transformers);
            });

            // Save to disk
            await window.electronAPI.saveFile(currentContent, filePath);

            // Update DocumentModel's echo-suppression baseline
            documentModel?.setLastPersistedContent(currentContent);

            // Push the resolved content to clean siblings so their editor
            // reflects the post-approval state (the model skips dirty
            // siblings, but they should be clean here since diff application
            // is wrapped in isApplyingDiffRef which suppresses dirty).
            documentModelHandleRef.current?.notifySiblingsSaved(currentContent);

            // Create history snapshot
            await window.electronAPI.invoke('history:create-snapshot', filePath, currentContent, 'manual', 'Incremental diff acceptance');

            // Advance the Codex cache so subsequent AI edits diff against post-review state
            if (clearSessionId) {
              window.electronAPI.invoke('ai:advance-diff-baseline', clearSessionId, filePath, currentContent);
            }

            // Update our state
            contentRef.current = currentContent;
            initialContentRef.current = currentContent;
            lastSavedContentRef.current = currentContent;
          }

          // Reload editor to exit diff mode and show clean final state
          const result = await window.electronAPI.readFileContent(filePath);
          if (result && result.success) {
            const finalContent = result.content;

            if (editorRef.current) {
              const transformers = getEditorTransformers();

              editorRef.current.update(() => {
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(finalContent, transformers);
              }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
            }
          }
      } catch (error) {
        logger.ui.error(`[TabEditor] Failed to clear diff tag:`, error);
      } finally {
        isClearingDiffTagRef.current = false;
      }
    };

    // Safety check - editor must have registerCommand method
    if (!editor || typeof editor.registerCommand !== 'function') {
      logger.ui.warn('[TabEditor] Editor instance is invalid, skipping command registration');
      return;
    }

    // Register command listeners
    // NOTE: APPROVE_DIFF_COMMAND and REJECT_DIFF_COMMAND are handled by DiffPlugin.
    // DiffPlugin dispatches CLEAR_DIFF_TAG_COMMAND when all diffs are processed.
    // handleClearDiffTag then saves the content to disk and clears the pending tag.
    // DO NOT clear pendingAIEditTagRef in these handlers - handleClearDiffTag needs it.

      // Handle APPROVE_DIFF_COMMAND - let DiffPlugin handle it
      const unregisterApprove = editor.registerCommand(
        APPROVE_DIFF_COMMAND,
        () => {
          // Let DiffPlugin handle the approval, then CLEAR_DIFF_TAG_COMMAND will save
          return false;
        },
        COMMAND_PRIORITY_LOW
      );

      // Handle REJECT_DIFF_COMMAND - let DiffPlugin handle it
      const unregisterReject = editor.registerCommand(
        REJECT_DIFF_COMMAND,
        () => {
          // Let DiffPlugin handle the rejection, then CLEAR_DIFF_TAG_COMMAND will save
          return false;
        },
        COMMAND_PRIORITY_LOW
      );

      const unregisterIncremental = editor.registerCommand(
        INCREMENTAL_APPROVAL_COMMAND,
        () => {
          handleIncrementalApproval().catch(err => {
            logger.ui.error('[TabEditor] Error in handleIncrementalApproval:', err);
          });
          return false; // Let other handlers run
        },
        COMMAND_PRIORITY_LOW
      );

      const unregisterClear = editor.registerCommand(
        CLEAR_DIFF_TAG_COMMAND,
        () => {
          handleClearDiffTag().catch(err => {
            logger.ui.error('[TabEditor] Error in handleClearDiffTag:', err);
          });
          return false; // Let other handlers run
        },
        COMMAND_PRIORITY_LOW
      );

    return () => {
      unregisterApprove();
      unregisterReject();
      unregisterIncremental();
      unregisterClear();
    };
  }, [filePath, isEditorReady]);

  // Image interaction callbacks
  const handleImageDoubleClick = useCallback(async (src: string, nodeKey: string) => {
    try {
      const result = await window.electronAPI.openImageInDefaultApp(src);
      if (!result.success) {
        logger.ui.error(`[TabEditor] Failed to open image:`, result.error);
      }
    } catch (error) {
      logger.ui.error(`[TabEditor] Error opening image:`, error);
    }
  }, []);

  const handleImageDragStart = useCallback(async (src: string, event: DragEvent) => {
    try {
      // The main process will handle the native drag operation
      await window.electronAPI.startImageDrag(src);
    } catch (error) {
      logger.ui.error(`[TabEditor] Error starting image drag:`, error);
    }
  }, []);

  // Monaco diff mode accept/reject handlers
  const handleMonacoDiffAccept = useCallback(async () => {
    // console.log('[TabEditor] !!!!! handleMonacoDiffAccept CALLED !!!!!');
    // console.log('[TabEditor] editorRef.current:', !!editorRef.current);
    // console.log('[TabEditor] editorRef.current.acceptDiff:', !!editorRef.current?.acceptDiff);
    // console.log('[TabEditor] pendingAIEditTagRef.current:', !!pendingAIEditTagRef.current);

    if (!editorRef.current?.acceptDiff || !pendingAIEditTagRef.current) {
      logger.ui.warn('[TabEditor] Cannot accept Monaco diff - no editor or pending tag', {
        hasEditor: !!editorRef.current,
        hasAcceptDiff: !!editorRef.current?.acceptDiff,
        hasPendingTag: !!pendingAIEditTagRef.current
      });
      return;
    }

    // console.log('[TabEditor] PASSED THE CHECK, ABOUT TO ENTER TRY BLOCK');

    try {
      // console.log('[TabEditor] INSIDE TRY BLOCK');
      logger.ui.info('[TabEditor] Accepting Monaco diff', {
        tagId: pendingAIEditTagRef.current.tagId,
        filePath
      });

      // console.log('[TabEditor] ABOUT TO CALL acceptDiff');
      // Get the new content from Monaco diff editor
      const newContent = editorRef.current.acceptDiff();
      // console.log('[TabEditor] acceptDiff RETURNED:', newContent.length);

      // console.log('[TabEditor] ABOUT TO WRITE TO DISK');
      // Write to disk - use saveFile with (content, filePath) parameter order
      try {
        await window.electronAPI.saveFile(newContent, filePath);
        // console.log('[TabEditor] WROTE TO DISK SUCCESSFULLY');
      } catch (writeError) {
        console.error('[TabEditor] ERROR WRITING TO DISK:', writeError);
        throw writeError;
      }

      // Mark tag as reviewed (must pass filePath, tagId, status, workspacePath)
      if (window.electronAPI.history) {
        // console.log('[TabEditor] About to call updateTagStatus', {
        //   filePath,
        //   tagId: pendingAIEditTagRef.current.tagId,
        //   status: 'reviewed',
        //   workspaceId
        // });

        await window.electronAPI.history.updateTagStatus(
          filePath,
          pendingAIEditTagRef.current.tagId,
          'reviewed',
          workspaceId
        );

        // console.log('[TabEditor] Successfully marked tag as reviewed');
      } else {
        console.warn('[TabEditor] No history API available');
      }

      // Create a history snapshot of the accepted content so future baseline
      // recovery (recoverBaselineFromHistory) finds it instead of older states.
      // Also advance the Codex FileSnapshotCache so subsequent AI edits diff
      // against the accepted state, not the pre-first-edit state.
      await window.electronAPI.invoke('history:create-snapshot', filePath, newContent, 'manual', 'Diff accepted');
      const acceptedSessionId = pendingAIEditTagRef.current?.sessionId;
      if (acceptedSessionId) {
        window.electronAPI.invoke('ai:advance-diff-baseline', acceptedSessionId, filePath, newContent);
      }

      // Exit diff mode
      // console.log('[TabEditor] ABOUT TO EXIT DIFF MODE');
      editorRef.current.exitDiffMode();
      // console.log('[TabEditor] EXIT DIFF MODE CALLED');

      // Clear pending tag ref
      setPendingAIEditTag(null);

      // Hide the diff approval bar and clear session info
      setShowMonacoDiffBar(false);
      setDiffSessionInfo(null);
      setMonacoDiffChangeCount(0);

      // Update content and saved state
      contentRef.current = newContent;
      lastSavedContentRef.current = newContent;
      isDirtyRef.current = false;

      // CRITICAL: Update Monaco editor's content after exiting diff mode
      // Without this, Monaco will revert to the old content when it switches back to normal mode
      // Use force: true because Monaco's disk tracker already has this content from acceptDiff()
      if (editorRef.current.setContent) {
        // console.log('[TabEditor] Updating Monaco editor content after diff acceptance');
        editorRef.current.setContent(newContent, { force: true });
      }

      // Tell DocumentModel the diff was resolved and propagate the new content
      // to sibling attachments (e.g. Files-mode tab when Agent-mode resolved)
      // so they exit diff mode too. Excludes our own editor id so we don't
      // recurse via onDiffResolved.
      documentModel?.clearDiffState(documentModelHandleRef.current?.id, true);
      documentModelHandleRef.current?.notifySiblingsSaved(newContent);

      logger.ui.info('[TabEditor] Monaco diff accepted successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error accepting Monaco diff:', error);
    }
  }, [filePath]);

  const handleMonacoDiffReject = useCallback(async () => {
    if (!editorRef.current?.rejectDiff || !pendingAIEditTagRef.current) {
      logger.ui.warn('[TabEditor] Cannot reject Monaco diff - no editor or pending tag');
      return;
    }

    try {
      logger.ui.info('[TabEditor] Rejecting Monaco diff');

      // Get the old content from Monaco diff editor
      const oldContent = editorRef.current.rejectDiff();

      // Write to disk - use saveFile with (content, filePath) parameter order
      await window.electronAPI.saveFile(oldContent, filePath);

      // Mark tag as reviewed (must pass filePath, tagId, status, workspacePath)
      if (window.electronAPI.history) {
        await window.electronAPI.history.updateTagStatus(
          filePath,
          pendingAIEditTagRef.current.tagId,
          'reviewed',
          workspaceId
        );
      }

      // Create a history snapshot of the rejected-to (original) content and advance
      // the Codex cache so subsequent AI edits diff against the post-rejection state.
      await window.electronAPI.invoke('history:create-snapshot', filePath, oldContent, 'manual', 'Diff rejected');
      const rejectedSessionId = pendingAIEditTagRef.current?.sessionId;
      if (rejectedSessionId) {
        window.electronAPI.invoke('ai:advance-diff-baseline', rejectedSessionId, filePath, oldContent);
      }

      // Exit diff mode
      editorRef.current.exitDiffMode();

      // Clear pending tag ref
      setPendingAIEditTag(null);

      // Hide the diff approval bar and clear session info
      setShowMonacoDiffBar(false);
      setDiffSessionInfo(null);
      setMonacoDiffChangeCount(0);

      // Update content and saved state
      contentRef.current = oldContent;
      lastSavedContentRef.current = oldContent;
      isDirtyRef.current = false;

      // CRITICAL: Update Monaco editor's content after exiting diff mode
      // Without this, Monaco will show the modified content when it switches back to normal mode
      // Use force: true because Monaco's disk tracker already has this content from rejectDiff()
      if (editorRef.current.setContent) {
        editorRef.current.setContent(oldContent, { force: true });
      }

      // Tell DocumentModel the diff was resolved (rejected) and propagate the
      // restored content so sibling attachments exit diff mode too.
      documentModel?.clearDiffState(documentModelHandleRef.current?.id, false);
      documentModelHandleRef.current?.notifySiblingsSaved(oldContent);

      logger.ui.info('[TabEditor] Monaco diff rejected successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error rejecting Monaco diff:', error);
    }
  }, [filePath]);

  // Custom editor diff mode accept/reject handlers
  const handleCustomEditorDiffAccept = useCallback(async () => {
    if (!pendingAIEditTagRef.current) {
      logger.ui.warn('[TabEditor] Cannot accept custom editor diff - no pending tag');
      return;
    }

    try {
      logger.ui.info('[TabEditor] Accepting custom editor diff', {
        tagId: pendingAIEditTagRef.current.tagId,
        filePath
      });

      // The custom editor already has the modified content displayed
      // We just need to save it (it's already on disk from the AI edit)
      // and mark the tag as reviewed

      // Mark tag as reviewed
      if (window.electronAPI.history) {
        await window.electronAPI.history.updateTagStatus(
          filePath,
          pendingAIEditTagRef.current.tagId,
          'reviewed',
          workspaceId
        );
      }

      // Read current disk content to snapshot and advance cache baseline
      const currentResult = await window.electronAPI.readFileContent(filePath);
      if (currentResult?.success && currentResult.content) {
        await window.electronAPI.invoke('history:create-snapshot', filePath, currentResult.content, 'manual', 'Diff accepted');
        const acceptedSessionId = pendingAIEditTagRef.current?.sessionId;
        if (acceptedSessionId) {
          window.electronAPI.invoke('ai:advance-diff-baseline', acceptedSessionId, filePath, currentResult.content);
        }
      }

      // Clear pending tag ref
      setPendingAIEditTag(null);

      // Hide the diff approval bar and clear session info
      setShowCustomEditorDiffBar(false);
      setDiffSessionInfo(null);

      // Notify the custom editor that diff mode has ended
      // The editor will reload content from disk via host.loadContent()
      diffClearedCallbackRef.current?.();

      // Fan out to sibling attachments so they exit diff mode too. Disk
      // already holds the AI-written (now-accepted) content; siblings will
      // pick it up via host.loadContent on their own diff-cleared callback.
      documentModel?.clearDiffState(documentModelHandleRef.current?.id, true);

      logger.ui.info('[TabEditor] Custom editor diff accepted successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error accepting custom editor diff:', error);
    }
  }, [filePath, workspaceId]);

  const handleCustomEditorDiffReject = useCallback(async () => {
    if (!pendingAIEditTagRef.current) {
      logger.ui.warn('[TabEditor] Cannot reject custom editor diff - no pending tag');
      return;
    }

    try {
      logger.ui.info('[TabEditor] Rejecting custom editor diff');

      // Get the original content from the pending tag
      const baseline = await window.electronAPI.invoke('history:get-diff-baseline', filePath);
      if (!baseline) {
        logger.ui.error('[TabEditor] Cannot reject - no baseline found');
        return;
      }

      // Write original content back to disk
      await window.electronAPI.saveFile(baseline.content, filePath);

      // Mark tag as reviewed
      if (window.electronAPI.history) {
        await window.electronAPI.history.updateTagStatus(
          filePath,
          pendingAIEditTagRef.current.tagId,
          'reviewed',
          workspaceId
        );
      }

      // Snapshot the restored content and advance the Codex cache baseline
      await window.electronAPI.invoke('history:create-snapshot', filePath, baseline.content, 'manual', 'Diff rejected');
      const rejectedSessionId = pendingAIEditTagRef.current?.sessionId;
      if (rejectedSessionId) {
        window.electronAPI.invoke('ai:advance-diff-baseline', rejectedSessionId, filePath, baseline.content);
      }

      // Clear pending tag ref
      setPendingAIEditTag(null);

      // Hide the diff approval bar and clear session info
      setShowCustomEditorDiffBar(false);
      setDiffSessionInfo(null);

      // Notify the custom editor that diff mode has ended
      // The editor will reload content from disk via host.loadContent()
      diffClearedCallbackRef.current?.();

      // Fan out to sibling attachments so they exit diff mode too.
      documentModel?.clearDiffState(documentModelHandleRef.current?.id, false);
      documentModelHandleRef.current?.notifySiblingsSaved(baseline.content);

      logger.ui.info('[TabEditor] Custom editor diff rejected successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error rejecting custom editor diff:', error);
    }
  }, [filePath, workspaceId]);

  // Create extension storage for custom editors
  // Uses the extension ID from the registered custom editor (if any)
  const extensionStorage = useMemo(() => {
    const extensionId = customEditorRegistration?.extensionId;
    if (!extensionId) {
      // Return a no-op storage for non-extension editors
      return {
        get: () => undefined,
        set: async () => {},
        delete: async () => {},
        getGlobal: () => undefined,
        setGlobal: async () => {},
        deleteGlobal: async () => {},
        getSecret: async () => undefined,
        setSecret: async () => {},
        deleteSecret: async () => {},
      };
    }
    return createExtensionStorage(extensionId);
  }, [customEditorRegistration?.extensionId]);

  // Create EditorHost for custom editors
  // This is memoized and uses refs for changing values to stay stable across renders
  // Only recreate when filePath or workspaceId changes (genuinely new file/workspace)
  const editorHost = useMemo<EditorHost>(() => {
    return createEditorHost({
      filePath,
      fileName,
      // Theme access via function - reads from ref so always current
      getTheme: () => themeRef.current,
      // Subscribe to theme changes
      subscribeToThemeChanges: (callback: (t: string) => void): (() => void) => {
        themeChangeCallbackRef.current = callback;
        return () => {
          themeChangeCallbackRef.current = null;
        };
      },
      // Use getter that accesses ref for value that can change but shouldn't recreate host
      get isActive() { return isActiveRef.current; },
      workspaceId,

      // Read file content from disk (text)
      readFile: async (path: string): Promise<string> => {
        // console.log('[TabEditor] readFile called for:', path);
        const result = await window.electronAPI.readFileContent(path);
        // console.log('[TabEditor] readFile result:', { success: result?.success, contentLength: result?.content?.length, first100: result?.content?.substring(0, 100) });
        if (!result || !result.success) return '';
        return result.content;
      },

      // Read file content from disk (binary)
      readBinaryFile: async (path: string): Promise<ArrayBuffer> => {
        const result = await window.electronAPI.readFileContent(path, { binary: true });
        if (!result || !result.success) {
          const errorMsg = result && !result.success ? result.error : 'Failed to read binary file';
          throw new Error(errorMsg);
        }
        // Convert base64 to ArrayBuffer
        const binaryString = atob(result.content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
      },

      // Subscribe to file changes
      // When DocumentModel is available, delegates to the handle for coordinated notifications.
      // The handle only fires when content actually changed (echo-suppressed, not our own save).
      // Falls back to ref-based callback wiring when no DocumentModel handle (shouldn't happen in practice).
      subscribeToFileChanges: (callback: (newContent: string) => void): (() => void) => {
        editorHostFileChangeCallbackRef.current = callback;
        // Also register with DocumentModel handle for coordinated notifications
        if (documentModelHandleRef.current) {
          return documentModelHandleRef.current.onFileChanged((content) => {
            if (typeof content !== 'string') return;
            // Mirror the built-in editor guard (the `onFileChanged` handler above
            // skips when isApplyingDiffRef/pendingAIEditTagRef is set): while an
            // AI-edit diff is in flight, don't deliver the raw file change to a
            // custom editor. Its external-change handler would discard the
            // pending-review diff before it can render (#328). The modified
            // content already reaches the editor through the diff request path,
            // and the final content arrives via diff resolution.
            if (isApplyingDiffRef.current || pendingAIEditTagRef.current) return;
            callback(content);
          });
        }
        return () => {
          editorHostFileChangeCallbackRef.current = null;
        };
      },

      // Report dirty state change
      // Delegates to DocumentModel handle when available, which aggregates dirty state
      // across all editors viewing this file.
      onDirtyChange: (isDirty: boolean) => {
        // Suppress dirty during programmatic content updates (sibling save sync, diff application).
        // Lexical's onChange fires after programmatic $getRoot().clear() + $convertFromMarkdown,
        // which would re-mark the editor dirty, creating a save-overwrite cycle between siblings.
        if (isDirty && (isApplyingExternalContentRef.current || isApplyingDiffRef.current)) {
          return;
        }
        if (isDirtyRef.current !== isDirty) {
          isDirtyRef.current = isDirty;
          // Report to DocumentModel for aggregation
          documentModelHandleRef.current?.setDirty(isDirty);
          // Update tab dirty indicator via DOM (no React state cascade)
          onDirtyChange?.(isDirty);
          // Update macOS window dirty indicator if this is the active tab
          if (isActive && window.electronAPI?.setDocumentEdited) {
            window.electronAPI.setDocumentEdited(isDirty);
          }
        }
      },

      // Save content to disk
      // Routes string saves through saveWithHistory so the built-in autosave
      // path participates in Layer D conflict detection (lastKnownContent
      // baseline) the same way TabEditor's manual/diff-driven saves do.
      // saveWithHistory also handles dirty-flag clearing, sibling notification,
      // history snapshotting, and the autosave-conflict banner.
      saveContent: async (content: string | ArrayBuffer): Promise<void> => {
        if (typeof content === 'string') {
          // Diff-mode guard: while AI diff nodes are still in the editor, the
          // disk holds the AI-written content and lastSavedContentRef holds the
          // pre-AI baseline -- Layer D would flag every autosave as a conflict
          // and interfere with the APPROVE_DIFF_COMMAND -> CLEAR_DIFF_TAG_COMMAND
          // chain. Mirror the same guard TabEditor's own onSaveRequested handler
          // applies (line ~990) so built-in editors honor diff mode too.
          if (pendingAIEditTagRef.current && editorRef.current && typeof editorRef.current.getEditorState === 'function') {
            const hasDiffs = editorRef.current.getEditorState().read(() => {
              return $hasDiffNodes(editorRef.current!);
            });
            if (hasDiffs) return;
          }
          await saveWithHistoryRef.current(content, 'auto', false);
          return;
        }

        // Binary path: DocumentModel saveContent does not currently support
        // ArrayBuffer with a conflict baseline. Fall back to the coordinated
        // DocumentModel save (still bypasses Layer D for binary, but no
        // built-in editor uses this path today).
        if (documentModelHandleRef.current) {
          await documentModelHandleRef.current.saveContent(content);
          lastSaveTimeRef.current = Date.now();
          isDirtyRef.current = false;
          onDirtyChange?.(false);
          return;
        }

        throw new Error('Binary content saving requires a DocumentModel handle');
      },

      // Subscribe to save requests from host (autosave timer, manual save)
      // DocumentModel's autosave timer calls this when it's time to save.
      subscribeToSaveRequests: (callback: () => void): (() => void) => {
        editorHostSaveRequestCallbackRef.current = callback;
        // Also register with DocumentModel handle for coordinated save requests
        if (documentModelHandleRef.current) {
          return documentModelHandleRef.current.onSaveRequested(callback);
        }
        return () => {
          editorHostSaveRequestCallbackRef.current = null;
        };
      },

      // Trigger immediate save (called after AI tool execution to prevent data loss)
      triggerSave: () => {
        editorHostSaveRequestCallbackRef.current?.();
      },

      // Open history dialog
      openHistory: () => {
        store.set(historyDialogFileAtom, filePath);
      },

      // Subscribe to diff requests (optional - for editors that support diff mode)
      subscribeToDiffRequests: customEditorSupportsDiffMode
        ? (callback: (config: DiffConfig) => void): (() => void) => {
            diffRequestCallbackRef.current = callback;
            return () => {
              diffRequestCallbackRef.current = null;
            };
          }
        : undefined,

      // Report diff result
      reportDiffResult: customEditorSupportsDiffMode
        ? async (result): Promise<void> => {
            if (!pendingAIEditTagRef.current) return;

            // Save the resulting content
            await window.electronAPI.saveFile(result.content, filePath);

            // Update tag status
            if (window.electronAPI.history) {
              await window.electronAPI.history.updateTagStatus(
                filePath,
                pendingAIEditTagRef.current.tagId,
                'reviewed',
                workspaceId
              );
            }

            // Clear pending tag
            setPendingAIEditTag(null);

            // Update state
            contentRef.current = result.content;
            lastSavedContentRef.current = result.content;
            isDirtyRef.current = false;
            onDirtyChange?.(false);
          }
        : undefined,

      // Check if diff mode is active
      isDiffModeActive: customEditorSupportsDiffMode
        ? () => {
            return pendingAIEditTagRef.current !== null;
          }
        : undefined,

      // Subscribe to diff being cleared externally (accept/reject from unified header)
      subscribeToDiffCleared: customEditorSupportsDiffMode
        ? (callback: () => void): (() => void) => {
            diffClearedCallbackRef.current = callback;
            return () => {
              diffClearedCallbackRef.current = null;
            };
          }
        : undefined,

      // ============ SOURCE MODE ============
      // Unified source mode handling for both markdown and custom editors
      // Source mode = Monaco with raw content; Rich mode = Lexical or custom editor

      // Whether this editor supports source mode toggle (markdown or custom editors that declare it)
      get supportsSourceMode() { return supportsSourceModeRef.current; },

      // Toggle source mode - works for both markdown and custom editors
      toggleSourceMode: async () => {
        const currentlyInSourceMode = sourceModeRef.current;

        // Pre-toggle save with Layer D conflict detection. If the file changed
        // on disk since we loaded/saved it, the dirty buffer about to be flushed
        // would silently overwrite the external write -- and the disk-reload
        // step that follows would then clobber the user's in-memory edits with
        // the foreign content. Surface the conflict and abort the toggle so the
        // user can resolve via the autosave-conflict banner.
        const flushDirtyBuffer = async (content: string): Promise<boolean> => {
          const expected = lastSavedContentRef.current;
          const result = await window.electronAPI.saveFile(content, filePath, expected);
          if (result?.conflict) {
            setAutosaveConflictDiskContent(typeof result.diskContent === 'string' ? result.diskContent : '');
            return false;
          }
          lastSavedContentRef.current = content;
          contentRef.current = content;
          isDirtyRef.current = false;
          onDirtyChange?.(false);
          return true;
        };

        if (currentlyInSourceMode) {
          // Switching FROM source mode (Monaco) TO rich editor (Lexical or custom)
          // Save Monaco's content to disk first so rich editor loads fresh data
          if (getContentFnRef.current && isDirtyRef.current) {
            const monacoContent = getContentFnRef.current();
            logger.ui.info(`[TabEditor] Saving source mode content before switching to rich editor: ${fileName}`);
            const saved = await flushDirtyBuffer(monacoContent);
            if (!saved) return;
          }
          // Reload content from disk so rich editor has fresh data
          try {
            const result = await window.electronAPI.readFileContent(filePath);
            if (result && result.success) {
              contentRef.current = result.content;
              lastSavedContentRef.current = result.content;
            }
          } catch (error) {
            logger.ui.error(`[TabEditor] Failed to load content for rich editor: ${filePath}`, error);
          }
        } else {
          // Switching TO source mode (Monaco) FROM rich editor (Lexical or custom)
          // First, save rich editor's content if dirty
          if (isDirtyRef.current) {
            if (getContentFnRef.current) {
              // Lexical and custom editors that expose getContent: do an
              // explicit Layer D-aware save so we can detect external-write
              // conflicts and abort the toggle. Note that MarkdownEditor sets
              // editorHostSaveRequestCallbackRef too, so we cannot use that ref
              // to discriminate "custom" from "lexical" -- and firing the host
              // callback fire-and-forget would lose conflict signal anyway.
              logger.ui.info(`[TabEditor] Saving rich editor content before switching to source mode: ${fileName}`);
              const richContent = getContentFnRef.current();
              const saved = await flushDirtyBuffer(richContent);
              if (!saved) return;
            } else if (editorHostSaveRequestCallbackRef.current) {
              // Custom editor with no getContent exposure (rare): fall back to
              // the host save callback. Cannot detect conflicts here -- the
              // extension is responsible for its own save semantics.
              logger.ui.info(`[TabEditor] Saving custom editor content (no getContent) before switching to source mode: ${fileName}`);
              editorHostSaveRequestCallbackRef.current();
            }
            // Give the save a moment to complete
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          // Reload content from disk so Monaco has fresh data
          try {
            const result = await window.electronAPI.readFileContent(filePath);
            if (result && result.success) {
              contentRef.current = result.content;
              lastSavedContentRef.current = result.content;
            }
          } catch (error) {
            logger.ui.error(`[TabEditor] Failed to load content for source mode: ${filePath}`, error);
          }
        }

        // Reset editor ready state so the pending diff check can run after new editor mounts
        setIsEditorReady(false);
        // Reset the pending tags check flag so it runs again after the new editor mounts
        hasCheckedForPendingTagsRef.current = false;
        setSourceMode(!currentlyInSourceMode);
        // Notify subscribers
        sourceModeChangedCallbackRef.current?.(!currentlyInSourceMode);
      },

      // Subscribe to source mode changes
      subscribeToSourceModeChanges: (callback: (isSourceMode: boolean) => void): (() => void) => {
        sourceModeChangedCallbackRef.current = callback;
        return () => {
          sourceModeChangedCallbackRef.current = null;
        };
      },

      // Check if source mode is active
      isSourceModeActive: () => {
        return sourceModeRef.current;
      },

      // ============ STORAGE ============
      storage: extensionStorage,

      // ============ EDITOR CONTEXT ============
      onEditorContextChanged: (context) => {
        setEditorContext(filePath, context);
      },

      // ============ MENU ITEMS ============
      onMenuItemsChanged: (items) => {
        setExtensionMenuItems(items);
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileName, workspaceId, extensionStorage, customEditorSupportsDiffMode]); // Recreate when file, workspace, storage, or diff support changes (theme accessed via themeRef)

  // Clean up editor context when tab unmounts
  useEffect(() => {
    return () => {
      clearEditorContext(filePath);
    };
  }, [filePath]);

  // Register manual save function for custom editors
  // This ensures saveTabById works when closing dirty custom editor tabs
  // Skip when in source mode - Monaco handles its own save registration
  useEffect(() => {
    if (!isCustom || !onManualSaveReady || sourceMode) return;

    // Register a save function that triggers the EditorHost callback
    const customEditorSave = async () => {
      if (editorHostSaveRequestCallbackRef.current) {
        logger.ui.info(`[TabEditor] Triggering custom editor save on close: ${fileName}`);
        await editorHostSaveRequestCallbackRef.current();
      }
    };
    onManualSaveReady(customEditorSave);
  }, [isCustom, onManualSaveReady, fileName, sourceMode]);

  // Note: isActive prop is always true (visibility controlled by parent wrapper)
  // Save handling: two paths converge here.
  // 1. Real Cmd+S on macOS: menu accelerator -> IPC 'file-save' -> TabContent dispatches
  //    'nimbalyst-save' CustomEvent on this container.
  // 2. Playwright/synthetic Cmd+S: keydown bubbles up to this container's onKeyDown.
  // Both call handleManualSave via ref to avoid stale closures.
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const handleManualSaveRef = useRef(handleManualSave);
  handleManualSaveRef.current = handleManualSave;

  useEffect(() => {
    const el = editorContainerRef.current;
    if (!el) return;
    const handler = () => { handleManualSaveRef.current(); };
    el.addEventListener('nimbalyst-save', handler);
    return () => { el.removeEventListener('nimbalyst-save', handler); };
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      e.stopPropagation();
      handleManualSaveRef.current();
    }
  }, []);

  // The parent sets display:none on the wrapper for inactive tabs
  // So we don't use isActive for styling - we're always "active" when visible
  return (
      <div
          ref={editorContainerRef}
          className="tab-editor multi-editor-instance flex flex-col h-full overflow-hidden relative"
          data-file-path={filePath}
          onKeyDown={handleKeyDown}
      >
        <UnifiedEditorHeaderBar
          filePath={filePath}
          fileName={fileName}
          workspaceId={workspaceId}
          isMarkdown={isMarkdown}
          isCustomEditor={isCustom}
          extensionId={customEditorRegistration?.extensionId}
          lexicalEditor={isMarkdown && !sourceMode ? editorRef.current : undefined}
          onToggleSourceMode={() => editorHost.toggleSourceMode?.()}
          supportsSourceMode={isMarkdown || customEditorSupportsSourceMode}
          isSourceModeActive={sourceMode}
          onDirtyChange={(isDirty) => {
            if (isDirty && (isApplyingExternalContentRef.current || isApplyingDiffRef.current)) return;
            isDirtyRef.current = isDirty;
            documentModelHandleRef.current?.setDirty(isDirty);
            onDirtyChange?.(isDirty);
          }}
          onSwitchToAgentMode={onSwitchToAgentMode}
          onOpenSessionInChat={onOpenSessionInChat}
          extensionMenuItems={extensionMenuItems}
          onToggleDebugTree={() => setShowTreeView(prev => !prev)}
          onContentChanged={() => setReloadVersion(v => v + 1)}
        />
        <FixedTabHeaderContainer
          filePath={filePath}
          fileName={fileName}
          editor={editorRef.current}
        />
        {autosaveConflictDiskContent !== null && (
          <div
            className="autosave-conflict-banner flex items-center gap-2 px-3 py-2 text-[13px] bg-nim-warning-subtle border-b border-nim-warning text-nim"
            role="alert"
            data-testid="autosave-conflict-banner"
          >
            <span className="flex-1">
              File changed on disk. Reload to see new content (your unsaved edits are preserved).
            </span>
            <button
              type="button"
              onClick={() => {
                const diskContent = autosaveConflictDiskContent;
                if (typeof diskContent === 'string' && editorRef.current) {
                  try {
                    if (isMarkdown) {
                      const transformers = getEditorTransformers();
                      editorRef.current.update(() => {
                        const root = $getRoot();
                        root.clear();
                        $convertFromEnhancedMarkdownString(diskContent, transformers);
                      }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
                    } else if (editorRef.current.setContent) {
                      editorRef.current.setContent(diskContent);
                    }
                  } catch (err) {
                    logger.ui.error('[TabEditor] Failed to reload disk content:', err);
                  }
                  contentRef.current = diskContent;
                  initialContentRef.current = diskContent;
                  lastSavedContentRef.current = diskContent;
                  isDirtyRef.current = false;
                  documentModelHandleRef.current?.setDirty(false);
                  onDirtyChange?.(false);
                }
                setAutosaveConflictDiskContent(null);
              }}
              className="px-2 py-1 rounded border border-nim text-nim hover:bg-nim-active"
              data-testid="autosave-conflict-banner-reload"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => setAutosaveConflictDiskContent(null)}
              className="px-2 py-1 rounded border border-nim text-nim hover:bg-nim-active"
              data-testid="autosave-conflict-banner-dismiss"
            >
              Dismiss
            </button>
          </div>
        )}
          {isCustom ? (() => {
            // Source mode: render Monaco instead of custom editor
            if (sourceMode) {
              return (
                <>
                  <div className="custom-editor-source-toolbar py-2 px-4 border-b border-nim flex justify-end items-center gap-2 bg-nim-secondary">
                    <span className="mr-auto text-[13px] text-nim-muted">
                      Source Mode
                    </span>
                    <button
                      onClick={() => editorHost.toggleSourceMode?.()}
                      className="py-1 px-3 text-[13px] cursor-pointer bg-nim border border-nim rounded text-nim"
                    >
                      Editor
                    </button>
                  </div>
                  <MonacoEditor
                    key={`${filePath}-source`}
                    host={editorHost}
                    fileName={fileName}
                    config={{
                      theme,
                      extensionThemeId: themeId,
                      isActive,
                    }}
                    onGetContent={(getContentFn) => {
                      getContentFnRef.current = getContentFn;
                      if (onGetContentReady) {
                        onGetContentReady(getContentFn);
                      }
                      if (onManualSaveReady) {
                        onManualSaveReady(handleManualSave);
                      }
                    }}
                    onEditorReady={(editorWrapper) => {
                      editorRef.current = editorWrapper;
                      setIsEditorReady(true);
                    }}
                  />
                </>
              );
            }

            // Render custom editor if one is registered for this file's
            // extension. Supports compound extensions of any depth via
            // longest-suffix match (e.g. .mockup.html, .reddit.watch.json).
            const registration = customEditorRegistry.findRegistrationForFile(filePath) ?? null;

            if (registration) {
              // Mark editor as ready when custom editor mounts
              // The editor will call host.loadContent() on mount
              if (!isEditorReady) {
                setIsEditorReady(true);
              }

              // Wrap extension-provided editors with protection
              // Built-in editors (no extensionId) are rendered directly
              if (registration.extensionId) {
                return (
                  <div className="custom-editor-container flex flex-col flex-1 min-h-0 overflow-hidden" data-extension-id={registration.extensionId} data-file-path={filePath}>
                    {customEditorShowsDocumentHeader && (
                      <DocumentHeaderContainer
                        filePath={filePath}
                        fileName={fileName}
                        getContent={getDocumentHeaderContent}
                        contentVersion={reloadVersion}
                        onContentChange={handleDocumentHeaderContentChange}
                      />
                    )}
                    {customEditorSupportsDiffMode && showCustomEditorDiffBar && (
                      <UnifiedDiffHeader
                        filePath={filePath}
                        fileName={fileName}
                        capabilities={{
                          onAcceptAll: handleCustomEditorDiffAccept,
                          onRejectAll: handleCustomEditorDiffReject,
                        }}
                        sessionInfo={diffSessionInfo || undefined}
                        onGoToSession={onOpenSessionInChat ? handleGoToSession : undefined}
                        editorType="custom"
                      />
                    )}
                    <CustomEditorWrapper
                      key={filePath}
                      component={registration.component}
                      host={editorHost}
                      extensionId={registration.extensionId}
                      componentName={registration.componentName}
                    />
                  </div>
                );
              }

              // Built-in custom editors (e.g., mockup editor) rendered directly
              const CustomEditor = registration.component;
              return (
                <div className="custom-editor-container flex flex-col flex-1 min-h-0 overflow-hidden">
                  {customEditorShowsDocumentHeader && (
                    <DocumentHeaderContainer
                      filePath={filePath}
                      fileName={fileName}
                      getContent={getDocumentHeaderContent}
                      contentVersion={reloadVersion}
                      onContentChange={handleDocumentHeaderContentChange}
                    />
                  )}
                  {customEditorSupportsDiffMode && showCustomEditorDiffBar && (
                    <UnifiedDiffHeader
                      filePath={filePath}
                      fileName={fileName}
                      capabilities={{
                        onAcceptAll: handleCustomEditorDiffAccept,
                        onRejectAll: handleCustomEditorDiffReject,
                      }}
                      sessionInfo={diffSessionInfo || undefined}
                      onGoToSession={onOpenSessionInChat ? handleGoToSession : undefined}
                      editorType="custom"
                    />
                  )}
                  <CustomEditor
                    key={filePath}
                    host={editorHost}
                  />
                </div>
              );
            }

            // Fallback if custom editor is not found (shouldn't happen)
            const fileExt = filePath.substring(filePath.lastIndexOf('.'));
            return (
              <div className="p-5 text-nim">
                <p>No custom editor found for file type: {fileExt}</p>
              </div>
            );
          })() : isImage ? (
            <ImageViewer
              key={filePath}
              filePath={filePath}
              fileName={fileName}
            />
          ) : isMarkdown && !sourceMode ? (
              <>
              <LexicalDiffHeaderAdapter
                editor={editorRef.current as any}
                filePath={filePath}
                fileName={fileName}
                sessionInfo={diffSessionInfo || undefined}
                onGoToSession={onOpenSessionInChat ? handleGoToSession : undefined}
              />
              <div className="tab-editor-wrapper flex-1 overflow-hidden relative">
              <DocumentPathProvider documentPath={filePath}>
                <MarkdownEditor
                  key={`${filePath}-lexical`}
                  host={editorHost}
                  config={{
                    theme,
                    onRenameDocument,
                    onSwitchToAgentMode,
                    onOpenSessionInChat,
                    onToggleMarkdownMode: () => editorHost.toggleSourceMode?.(),
                    onImageDoubleClick: handleImageDoubleClick,
                    onImageDragStart: handleImageDragStart,
                    showTreeView, // Debug tree view (dev mode)
                    documentHeader: (
                      <DocumentHeaderContainer
                        filePath={filePath}
                        fileName={fileName}
                        getContent={getDocumentHeaderContent}
                        contentVersion={reloadVersion}
                        onContentChange={handleDocumentHeaderContentChange}
                        editor={editorRef.current}
                      />
                    ),
                  }}
                  collaborationConfig={personalSyncConfig || undefined}
                  onEditorReady={(editor) => {
                    editorRef.current = editor;
                    setIsEditorReady(true);
                    // Force FixedTabHeaderRegistry to re-evaluate after editor remounts
                    setTimeout(() => {
                      FixedTabHeaderRegistry.getInstance().notifyChange();
                    }, 150);
                    // Expose manual save function
                    if (onManualSaveReady) {
                      onManualSaveReady(handleManualSave);
                    }
                  }}
                  onGetContent={(getContentFn) => {
                    getContentFnRef.current = getContentFn;
                    if (onGetContentReady) {
                      onGetContentReady(getContentFn);
                    }
                  }}
                />
              </DocumentPathProvider>
              </div>
              </>
          ) : isMarkdown && sourceMode ? (
            <>
              <div className="monaco-markdown-toolbar py-2 px-4 border-b border-nim flex justify-end items-center gap-2 bg-nim-secondary">
                <span className="mr-auto text-[13px] text-nim-muted">
                  Source Mode
                </span>
                <button
                  onClick={() => editorHost.toggleSourceMode?.()}
                  className="py-1 px-3 text-[13px] cursor-pointer bg-nim border border-nim rounded text-nim"
                >
                  Rich Text
                </button>
              </div>
              <MonacoEditor
                key={`${filePath}-monaco`}
                host={editorHost}
                fileName={fileName}
                config={{
                  theme,
                  extensionThemeId: themeId,
                  isActive,
                }}
                onGetContent={(getContentFn) => {
                  getContentFnRef.current = getContentFn;
                  if (onGetContentReady) {
                    onGetContentReady(getContentFn);
                  }
                  // Expose the manual save function
                  if (onManualSaveReady) {
                    onManualSaveReady(handleManualSave);
                  }
                }}
                onEditorReady={(editorWrapper) => {
                  // For Monaco, we get a wrapper with editor, setContent, getContent
                  editorRef.current = editorWrapper;
                  setIsEditorReady(true);
                }}
              />
            </>
          ) : (
            <>
              {!isMarkdown && (
                <DocumentHeaderContainer
                  filePath={filePath}
                  fileName={fileName}
                  getContent={getDocumentHeaderContent}
                  contentVersion={reloadVersion}
                  onContentChange={handleDocumentHeaderContentChange}
                />
              )}
              {!isMarkdown && showMonacoDiffBar && (
                <UnifiedDiffHeader
                  filePath={filePath}
                  fileName={fileName}
                  capabilities={{
                    onAcceptAll: handleMonacoDiffAccept,
                    onRejectAll: handleMonacoDiffReject,
                    changeGroups: monacoDiffChangeCount > 0 ? {
                      count: monacoDiffChangeCount,
                      currentIndex: null, // Monaco doesn't track current index reliably
                      onNavigatePrevious: () => editorRef.current?.goToPreviousDiff?.(),
                      onNavigateNext: () => editorRef.current?.goToNextDiff?.(),
                      // Monaco doesn't support per-change accept/reject
                      supportsPerChangeActions: false,
                    } : undefined,
                  }}
                  sessionInfo={diffSessionInfo || undefined}
                  onGoToSession={onOpenSessionInChat ? handleGoToSession : undefined}
                  editorType="monaco"
                />
              )}
              <MonacoEditor
                key={filePath}
                host={editorHost}
                fileName={fileName}
                config={{
                  theme,
                  extensionThemeId: themeId,
                  isActive,
                }}
                onGetContent={(getContentFn) => {
                  getContentFnRef.current = getContentFn;
                  if (onGetContentReady) {
                    onGetContentReady(getContentFn);
                  }
                  // Expose the manual save function
                  if (onManualSaveReady) {
                    onManualSaveReady(handleManualSave);
                  }
                }}
                onEditorReady={(editorWrapper) => {
                  // For Monaco, we get a wrapper with editor, setContent, getContent, showDiff, etc.
                  editorRef.current = editorWrapper;
                  setIsEditorReady(true);
                }}
                onDiffChangeCountUpdate={(count) => {
                  setMonacoDiffChangeCount(count);
                }}
              />
            </>
          )}


        {showConflictDialog && (
          <div
            className="file-conflict-dialog-overlay absolute inset-0 bg-black/50 flex items-center justify-center z-[1000]"
          >
            <div
              className="file-conflict-dialog bg-nim border border-nim rounded-lg p-6 max-w-[500px] shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
            >
              <h3 className="mt-0 text-nim">File Changed on Disk</h3>
              <p className="text-nim-muted">
                The file "{fileName}" has been changed on disk but you have unsaved changes.
              </p>
              <p className="text-nim-muted">
                Do you want to reload the file from disk and lose your changes?
              </p>
              <div className="flex gap-3 mt-6 justify-end">
                <button
                  onClick={handleKeepLocalChanges}
                  className="py-2 px-4 bg-nim-secondary border border-nim rounded text-nim cursor-pointer"
                >
                  Keep My Changes
                </button>
                <button
                  onClick={handleReloadFromDisk}
                  className="py-2 px-4 bg-nim-primary border-none rounded text-nim-on-primary cursor-pointer"
                >
                  Reload from Disk
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
  );
};
