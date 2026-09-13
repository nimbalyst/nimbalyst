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
import { $getRoot, $getSelection, $isRangeSelection, $setSelection, SKIP_SCROLL_INTO_VIEW_TAG, SKIP_DOM_SELECTION_TAG, COMMAND_PRIORITY_LOW } from 'lexical';
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
import type { EditorHost, DiffConfig, ProjectFileWriteReceipt, EditorHostFileSystem } from '@nimbalyst/runtime';
import { createProjectFileSystemHost } from '../../services/projectFileSystemHost';
import { createExtensionStorage, createElementVisibilityTracker } from '@nimbalyst/runtime';
import { setEditorContext, setEditorContextItems, clearEditorContext } from '../../stores/editorContextStore';
import { store, editorHasUnacceptedChangesAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { historyDialogFileAtom } from '../../store';
import { UnifiedEditorHeaderBar } from './UnifiedEditorHeaderBar';
import type { DocumentSessionActions } from './DocumentSessionControl';
import { usePersonalDocSync } from '../../hooks/usePersonalDocSync';
import { useDocumentModel } from '../../services/document-model/useDocumentModel';
import { DocumentModelRegistry } from '../../services/document-model/DocumentModelRegistry';
import type { DiffApplyOutcome, DiffState } from '../../services/document-model/types';
import { diffTrace } from '@nimbalyst/runtime/utils/debugFlags';
import { SearchReplaceStateManager, isLexicalSearchEditor } from '@nimbalyst/runtime/plugins/SearchReplace';
import { hasEditorFind, registerEditorFindHandler } from './editorFindCommand';
import { hasEditorReveal, registerEditorRevealHandler } from './editorRevealCommand';
import { revealMarkdownLine } from '@nimbalyst/runtime/editor/markdown/revealMarkdownLine';
import { useSuppressedDocumentHeaderProviderIds } from './DocumentHeaderSuppressionContext';
import { createCollectionItem } from '../TrackerMode/createCollectionItem';
import { loadTrackerTeamMembers } from '../TrackerMode/useTrackerTeamMembers';
import { assertFileSaveSucceeded, getSaveFailureMessage, resolveSaveFailureType, type FileSaveResult } from '../../utils/fileSaveResult';
import { resolveSaveAttempt } from './resolveSaveAttempt';
import { reloadFromDisk, type ReloadOutcome } from './reloadFromDisk';
import { resolveDiffResolutionSave } from './resolveDiffResolutionSave';
import {
  decideLexicalDiffByBytes,
  decideLexicalDiffByRootNodes,
} from './lexicalDiffPresentation';
import {
  resolveDiffAutosaveGate,
  resolveManualSaveReviewGate,
  type DiffPresentationMode,
} from './resolveDiffAutosaveGate';

/**
 * How the autosave gate must read each apply outcome. `detached` maps to
 * `failed` on purpose: an attachment that could not present the generation has
 * no more evidence about the buffer than one whose apply threw.
 */
const PRESENTATION_FOR_OUTCOME: Record<DiffApplyOutcome, DiffPresentationMode> = {
  applied: 'inline',
  'presented-without-inline': 'presented-without-inline',
  failed: 'failed',
  detached: 'failed',
};

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
  const customEditorReadOnlyDuringDiff = customEditorRegistration?.readOnlyDuringDiff === true;
  // A host may already present one registered header (Tracker Mode presents the
  // tracker chips). Preserve every other provider rather than hiding the whole
  // document-header region.
  const excludedDocumentHeaderProviderIds = useSuppressedDocumentHeaderProviderIds();
  const customEditorShowsDocumentHeader = customEditorRegistration?.showDocumentHeader !== false;
  const loadDocumentHeaderTeamMembers = useCallback(
    () => workspaceId ? loadTrackerTeamMembers(workspaceId) : Promise.resolve([]),
    [workspaceId],
  );
  const createDocumentHeaderCollection = useCallback(
    (title: string, type: string) => workspaceId
      ? createCollectionItem({ workspacePath: workspaceId, title, type })
      : Promise.resolve(null),
    [workspaceId],
  );
  const trackerFieldCapabilities = useMemo(() => ({
    loadTeamMembers: loadDocumentHeaderTeamMembers,
    onCreateCollection: workspaceId ? createDocumentHeaderCollection : undefined,
  }), [createDocumentHeaderCollection, loadDocumentHeaderTeamMembers, workspaceId]);

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
  const [saveFailure, setSaveFailure] = useState<{
    errorType: string;
    source: 'auto' | 'manual';
  } | null>(null);
  const assertManualSaveSucceeded = useCallback((result: FileSaveResult | null) => {
    if (!result?.success) {
      setSaveFailure({ errorType: resolveSaveFailureType(result), source: 'manual' });
    } else {
      setSaveFailure(null);
    }
    assertFileSaveSucceeded(result);
  }, []);
  const [showMonacoDiffBar, setShowMonacoDiffBar] = useState(false); // For Monaco diff approval bar
  const [showCustomEditorDiffBar, setShowCustomEditorDiffBar] = useState(false); // For custom editor diff approval bar
  // A markdown review the document was too large to render inline (#4821). The
  // Lexical header keys off diff nodes, of which there are none here, so without
  // its own bar the user has a pending review and no way to act on it.
  const [noInlineFallbackReview, setNoInlineFallbackReview] = useState(false);
  // A diff-capable custom editor has registered its own diff callback. That
  // registration -- not a timer -- is what makes this attachment a presenter.
  const [customDiffPresenterReady, setCustomDiffPresenterReady] = useState(false);
  const [isEditorReady, setIsEditorReady] = useState(false); // Track when editor is mounted and ready
  const [diffSessionInfo, setDiffSessionInfo] = useState<{sessionId: string; sessionTitle?: string; editedAt?: number; provider?: string} | null>(null); // Session info for diff approval bar
  const [monacoDiffChangeCount, setMonacoDiffChangeCount] = useState(0); // Number of changes in Monaco diff mode
  const [showTreeView, setShowTreeView] = useState(false); // Debug tree view for Lexical (dev mode only)

  // Track editor type usage when a file is opened.
  //
  // The emission is deferred until the resolved editor type settles. At startup
  // a file can mount in its fallback editor (Monaco/Lexical) before the
  // extension that owns its compound type (e.g. `.mockup.html`, `.calc.md`)
  // finishes registering. Emitting immediately would misreport it as `.html` /
  // `.md`, and the one-shot guard would lock that in. We instead wait a short
  // grace period and re-arm whenever the custom-editor registry changes
  // (registryVersion), so we emit exactly once with the final editor type.
  const hasTrackedOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isActive || !isEditorReady) return;
    if (hasTrackedOpenRef.current === filePath) return;

    const timer = setTimeout(() => {
      if (hasTrackedOpenRef.current === filePath) return;
      hasTrackedOpenRef.current = filePath;

      // Resolve the editor type from the live registry at emit time so a
      // late-registering extension editor is reported correctly. For custom
      // editors, prefer the registered key (e.g. '.reddit.watch.json',
      // '.mockup.html') so analytics reflect the compound extension matched on,
      // not just the file's final segment.
      const customMatch = customEditorRegistry.findMatchForFile(filePath);
      let fileExtension: string;
      if (customMatch) {
        fileExtension = customMatch.key;
      } else {
        const lastDot = filePath.lastIndexOf('.');
        fileExtension = lastDot >= 0 ? filePath.substring(lastDot).toLowerCase() : '';
      }

      const resolvedType = getFileType(filePath, () => customMatch != null);
      let editorCategory: string;
      let hasMermaid = false;
      let hasDataModel = false;
      if (resolvedType === 'custom') {
        // Use the registered editor name (e.g. "Mockup Editor", "PDF Viewer").
        editorCategory = customMatch?.registration.name || 'custom';
      } else if (resolvedType === 'markdown') {
        editorCategory = 'markdown';
        if (initialContent.includes('```mermaid') || initialContent.includes('~~~mermaid')) {
          hasMermaid = true;
        }
        if (initialContent.includes('```datamodel') || initialContent.includes('datamodel:')) {
          hasDataModel = true;
        }
      } else if (resolvedType === 'image') {
        editorCategory = 'image';
      } else {
        editorCategory = 'monaco';
      }

      posthog?.capture('editor_type_opened', {
        editorCategory,
        fileExtension,
        hasMermaid,
        hasDataModel,
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [isActive, isEditorReady, filePath, registryVersion, posthog, initialContent]);

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
  // The live editor instance as STATE (mirrors editorRef.current). Selection
  // tracking depends on this so it re-registers when the editor remounts; a ref
  // alone doesn't trigger the effect and left the listener on a dead instance.
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const initialContentRef = useRef(initialContent);
  const lastSaveTimeRef = useRef<number | null>(null);
  const lastSavedContentRef = useRef<string>(initialContent);
  const isSavingRef = useRef<boolean>(false);
  const saveIdRef = useRef<number>(0);
  const pendingSaveIdsRef = useRef<Set<number>>(new Set());
  const instanceIdRef = useRef<number>(Math.floor(Math.random() * 10000));
  const hasInitialContentSyncRef = useRef<boolean>(false);
  const pendingAIEditTagRef = useRef<{tagId: string, sessionId: string, filePath: string} | null>(null);
  // The outcome this tab last reported, tied to the generation it reported on.
  // The autosave gate reads it: zero diff nodes only means "resolved by hand"
  // for a generation that verifiably rendered inline (NIM-5359, defect A).
  const presentedGenerationRef = useRef<{ generation: number; mode: DiffPresentationMode } | null>(null);
  const isApplyingDiffRef = useRef<boolean>(false); // Track programmatic diff application
  // #3684: set when a reload could not be verified, i.e. the buffer is not a
  // trustworthy picture of anything. Writes are blocked while it is set --
  // a tab that does not know what is on disk must not write to it -- and
  // self-heal retries from a fresh disk read until it clears. See reloadFromDisk.ts.
  const unverifiedReloadRef = useRef<{ incoming: string; attempts: number } | null>(null);
  const selfHealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isApplyingExternalContentRef = useRef<boolean>(false); // Guard: programmatic content update from sibling save
  const isClearingDiffTagRef = useRef<boolean>(false); // Guard against pending-cleared reload race
  const editorHostFileChangeCallbackRef = useRef<((newContent: string) => void) | null>(null); // For EditorHost file change subscription
  const diffRequestCallbackRef = useRef<((config: DiffConfig) => void) | null>(null); // For EditorHost diff request subscription
  const customEditorFindCallbackRef = useRef<(() => void) | null>(null); // Custom editor's own find UI (see EditorHost.onFindRequested)
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
    // The no-inline bar exists only for the duration of one pending review, so
    // it retires through the same choke point rather than in each caller.
    if (tag === null) {
      setNoInlineFallbackReview(false);
      presentedGenerationRef.current = null;
    }
    // Update Jotai atom so tab indicator subscribes to it
    store.set(editorHasUnacceptedChangesAtom(editorKey), tag !== null);
  }, [editorKey]);

  /**
   * True while an agent edit is still under review, from any of the three places
   * that can know it: this tab's pending tag, the model's live diff state, or a
   * resolution that reached disk but not the history tag. Source mode consults
   * this before every write -- it renders no diff, so a save from there is a
   * write against content the user has never been shown (NIM-5359).
   */
  const hasUnresolvedReview = useCallback((): boolean => (
    pendingAIEditTagRef.current !== null ||
    documentModel?.getDiffState() !== null ||
    !!documentModel?.isSaveBlockedByPendingResolution()
  ), [documentModel]);

  // Refs for EditorHost stability - these allow editorHost to access current values without recreating
  const themeRef = useRef(theme);
  const isActiveRef = useRef(isActive);
  // On-screen visibility (tab display toggles AND hidden modes) — observed via
  // IntersectionObserver on the container; backs host.visible/onVisibilityChanged.
  const visibleRef = useRef(true);
  const visibilityCallbacksRef = useRef(new Set<(visible: boolean) => void>());
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

  // What the header-bar session control may do with this document's sessions.
  const documentSessionActions = useMemo<DocumentSessionActions>(() => ({
    openInChat: onOpenSessionInChat,
    openInAgentMode: onSwitchToAgentMode
      ? (sessionId: string) => onSwitchToAgentMode(undefined, sessionId)
      : undefined,
    startNew: onSwitchToAgentMode && filePath ? () => onSwitchToAgentMode(filePath) : undefined,
  }), [onOpenSessionInChat, onSwitchToAgentMode, filePath]);

  // Notify custom editors of theme changes (themeRef is updated synchronously above)
  useEffect(() => {
    if (themeChangeCallbackRef.current) {
      themeChangeCallbackRef.current(theme);
    }
  }, [theme]);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { sourceModeRef.current = sourceMode; }, [sourceMode]);
  useEffect(() => { supportsSourceModeRef.current = isMarkdown || customEditorSupportsSourceMode; }, [isMarkdown, customEditorSupportsSourceMode]);

  // Gated on isEditorReady for the same reason the DocumentModel callbacks are
  // (see the note further down): registering earlier drains a pending reveal
  // against a null editorRef, which does nothing and consumes the request.
  useEffect(() => {
    if (!isEditorReady) return;

    return registerEditorRevealHandler(filePath, ({ line, column }) => {
      const editor = editorRef.current;
      if (!editor) return;

      // Monaco (code files, and markdown in source mode) reveals the exact line.
      if (hasEditorReveal(editor)) {
        editor.revealPosition(line, column);
        return;
      }

      // The rich markdown view has no lines; map the line onto a block.
      if (isMarkdown && !sourceModeRef.current) {
        revealMarkdownLine({
          editor,
          transformers: getEditorTransformers(),
          line,
          sourceText: contentRef.current,
        });
      }
    });
  }, [filePath, isEditorReady, isMarkdown]);

  useEffect(() => {
    return registerEditorFindHandler(filePath, () => {
      // A custom editor never populates editorRef, so its own find UI is
      // reached through the host callback it registered instead.
      const customEditorFind = customEditorFindCallbackRef.current;
      if (customEditorFind) {
        customEditorFind();
        return;
      }
      const editor = editorRef.current;
      if (hasEditorFind(editor)) {
        editor.openFind();
      } else if (isLexicalSearchEditor(editor)) {
        SearchReplaceStateManager.openAndFocus(filePath);
      }
    });
  }, [filePath]);

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
      clearTextSelection(filePath);
      return undefined;
    }

    // Bind against the LIVE editor instance (state), not editorRef.current.
    // The Lexical/Monaco editor can remount after the tab is already "ready"
    // (extension reload, diff-mode swap, theme change) — each remount produces
    // a NEW editor instance and re-fires onEditorReady. Because `editorInstance`
    // is a dependency of this effect, we re-register the selection listener on
    // the new instance. Keying on the ref instead left the listener attached to
    // the destroyed editor, so selections silently stopped reaching the AI
    // "+ selection" context after the first remount.
    if (!isEditorReady || !editorInstance) {
      return undefined;
    }

    // Debounce timer for selection updates
    let debounceTimer: NodeJS.Timeout | null = null;

    // For Lexical editor (markdown in rich text mode)
    if (isMarkdown && !sourceMode) {
      const editor = editorInstance;
      if (editor?.registerUpdateListener) {
        // When tab becomes active, clear any stale selection state
        // The Lexical SelectionAlwaysOnDisplay plugin may show a visual selection,
        // but we want a clean slate - user must re-select to use "+ selection" feature
        clearTextSelection(filePath);

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
                  clearTextSelection(filePath);
                }
              } else {
                // User clicked in editor without selection - clear it
                clearTextSelection(filePath);
              }
            });
          }, 150); // 150ms debounce
        });
        return () => {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          unregister();
          clearTextSelection(filePath);
        };
      }
      return undefined;
    }

    // For Monaco editor (code files or markdown/custom editor in source mode)
    if (!isMarkdown || sourceMode) {
      const monacoEditor = editorInstance?.editor;
      if (monacoEditor?.onDidChangeCursorSelection) {
        // When tab becomes active, clear any stale selection state
        clearTextSelection(filePath);

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
                  clearTextSelection(filePath);
                }
              }
            } else {
              // User clicked in editor without selection - clear it
              clearTextSelection(filePath);
            }
          }, 150); // 150ms debounce
        });
        return () => {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          disposable.dispose();
          clearTextSelection(filePath);
        };
      }
    }
    return undefined;
  }, [isActive, isEditorReady, isMarkdown, sourceMode, filePath, editorInstance]);

  // NIM-5359 defect H: the production hydration seam.
  //
  // The DocumentModel -- not this component -- decides whether a reopened file is
  // under review. It looks up the pending tag and the diff baseline itself and
  // publishes through the ordinary onDiffRequested subscription below, now the
  // only presentation path. `initialContent` is the bytes this editor actually
  // loaded; that is the whole point, because a hydration seam only tests call is
  // a seam production never uses.
  //
  useEffect(() => {
    if (!isEditorReady) return;
    // Hydrate in source mode too. Source mode is not a presenter, so the
    // generation parks as `awaiting-presenter` -- but the model must still know
    // a review is open, because that is what blocks raw source saves and what
    // gets published the moment the rich editor comes back.
    void documentModel.ensureInitialized(initialContent).catch(() => {
      // Logged inside the model, which also owns the bounded retry.
    });
  }, [documentModel, initialContent, isEditorReady, sourceMode]);

  // Helper: Save file with history snapshot
  // skipDiffCheck: Set to true when saving during AI operations (accept/reject/streaming)
  const saveWithHistory = useCallback(async (
      contentToSave: string,
      snapshotType: 'auto' | 'manual' = 'auto',
      skipDiffCheck: boolean = false
  ) => {
    if (!window.electronAPI) return;
    // Source mode is not a diff presenter, so this buffer has never been shown
    // the agent's write -- writing it back is the revert the whole plan is
    // about. Blocked at the entry rather than in the autosave gate because
    // manual save (Cmd+S -> handleManualSave) comes straight here (NIM-5359).
    if (sourceModeRef.current && hasUnresolvedReview()) {
      logger.ui.warn(
        `[TabEditor] Source-mode save refused for ${fileName}: an AI edit is still pending review`,
      );
      return;
    }

    const expectedDiskContent = lastSavedContentRef.current;
    // Generate a unique save ID to track this specific save operation
    const thisSaveId = ++saveIdRef.current;
    pendingSaveIdsRef.current.add(thisSaveId);

    // The local baseline and the DocumentModel echo-suppression baseline must
    // always move together -- writing one without the other leaves the next
    // conflict check comparing against content that is not on disk. Every exit
    // path below goes through here so a new branch cannot forget one of them.
    const setPersistedBaseline = (content: string) => {
      lastSavedContentRef.current = content;
      documentModel?.setLastPersistedContent(content);
    };
    // Post-write bookkeeping (history snapshot, tag updates) can still throw
    // after the bytes are on disk. The catch below must not rewind the
    // baseline in that case -- disk really does hold contentToSave.
    let contentReachedDisk = false;

    try {

      // Capture the content we expect to be on disk BEFORE we optimistically
      // overwrite lastSavedContentRef. This becomes the `lastKnownContent`
      // baseline for the IPC's conflict check: if disk contains anything
      // else, we know an external process changed the file (e.g. an AI
      // session recreated a previously-deleted file). For autosave, the
      // conflict path preserves the buffer rather than clobbering disk.
      // Set saving flag BEFORE saving to prevent file watcher from reloading
      isSavingRef.current = true;

      // Update refs BEFORE saving so file watcher can detect it's our own save
      // CRITICAL: Update both ref and state synchronously to ensure file watcher sees the change
      const saveTime = Date.now();
      lastSaveTimeRef.current = saveTime;

      // Update the baseline BEFORE writing to disk. The file watcher can fire
      // before saveFile returns, and echo suppression needs to see the new
      // content as "ours" to avoid unnecessary getPendingTags calls.
      setPersistedBaseline(contentToSave);

      logger.ui.info(`[TabEditor] Saving ${fileName}, saveId=${thisSaveId}, skipDiffCheck=${skipDiffCheck}`);

      // Save to disk with conflict detection. Always pass lastKnownContent so
      // the main process can detect external changes and refuse to overwrite
      // them silently. resolveSaveAttempt owns the conflict prompt and the
      // forced retry; every outcome it returns carries the baseline that must
      // end up persisted, so no branch here can forget to rewind or advance it.
      const outcome = await resolveSaveAttempt(
        { contentToSave, expectedDiskContent, filePath, snapshotType },
        {
          saveFile: (content, path, lastKnown, source) =>
            window.electronAPI.saveFile(content, path, lastKnown, source),
          confirmOverwrite: () => {
            logger.ui.info('[TabEditor] Save conflict detected, prompting user');
            return window.confirm(
              'The file has been modified externally since you opened it.\n\n' +
              'Do you want to overwrite the external changes with your edits?\n\n' +
              'Click OK to overwrite, or Cancel to reload the file from disk.'
            );
          },
        },
      );

      setPersistedBaseline(outcome.baseline);

      if (outcome.kind === 'autosave-conflict') {
        // Autosave path: never overwrite silently, never prompt. Show a
        // non-blocking banner. Buffer is preserved as-is. The user can click
        // "Reload" to pick up disk content. The DocumentModel runs only its
        // bounded retry sequence while the banner stays up.
        logger.ui.info('[TabEditor] Autosave conflict detected -- showing non-blocking banner, buffer preserved');
        setAutosaveConflictDiskContent(outcome.diskContent);
        // Keep the buffer dirty so the user's edits are preserved.
        // Don't proceed to history snapshot for this failed save.
        throw new Error('Autosave blocked by a disk conflict');
      }

      if (outcome.kind === 'failed') {
        setSaveFailure({ errorType: outcome.errorType, source: snapshotType });
        throw new Error(`File save failed (${outcome.errorType})`);
      }

      if (outcome.kind === 'reload') {
        // User chose to reload - update editor with disk content
        // Update editor content programmatically to avoid remount
        const diskContent = outcome.diskContent;
        if (editorRef.current) {
          try {
            // Import Lexical functions from 'lexical' and editor functions from '@nimbalyst/runtime'
            const transformers = getEditorTransformers();

            editorRef.current.update(() => {
              // Clearing a selected node without moving selection first makes
              // Lexical throw "selection has been lost ..." (NIM-2005).
              $setSelection(null);
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
        isDirtyRef.current = false;
        documentModelHandleRef.current?.setDirty(false);
        onDirtyChange?.(false);
        setSaveFailure(null);
        pendingSaveIdsRef.current.delete(thisSaveId);
        isSavingRef.current = false;
        return;
      }

      const finalResult = outcome.result;
      if (outcome.forced) {
        // The forced write is the one that reached disk, so echo suppression
        // should be measured from it, not the refused attempt.
        lastSaveTimeRef.current = Date.now();
      }
      contentReachedDisk = true;

      // IMMEDIATE: Clear dirty flag as soon as save succeeds
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
      setSaveFailure(null);
      setAutosaveConflictDiskContent(null);

        // Create history snapshot
        if (window.electronAPI.history) {
          try {
            const description = snapshotType === 'manual' ? 'Manual save' : 'Auto-save';
            const dbSnapshotType = snapshotType === 'manual' ? 'manual' : 'auto-save';
            await window.electronAPI.history.createSnapshot(
                finalResult.filePath,
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
        onSaveComplete?.(finalResult.filePath);

        // Clear this save ID after a delay to ensure file watcher events are processed
        // File watchers can be slow, especially on macOS, so use a generous timeout
        setTimeout(() => {
          pendingSaveIdsRef.current.delete(thisSaveId);
          // Only clear isSaving if no pending saves
          if (pendingSaveIdsRef.current.size === 0) {
            isSavingRef.current = false;
          }
        }, 10000);
    } catch (error) {
      logger.ui.error(`[TabEditor] Failed to save file ${filePath}:`, error);
      // Reset refs on error
      lastSaveTimeRef.current = null;
      setPersistedBaseline(contentReachedDisk ? contentToSave : expectedDiskContent);
      pendingSaveIdsRef.current.delete(thisSaveId);
      isSavingRef.current = false;
      throw error;
    }
  }, [filePath, fileName, onSaveComplete, hasUnresolvedReview]);

  /**
   * Push external content into the editor and verify it landed (#3684).
   *
   * The apply strategy is chosen from what the mounted editor actually
   * supports, not from the file extension. Picking it off `isMarkdown` meant
   * that in markdown source mode -- where `editorRef` holds the Monaco wrapper
   * -- the reload called a Lexical-only `update()` that went nowhere, silently.
   * That was one of the ways a buffer ended up stale while the baseline moved.
   *
   * `readBuffer` deliberately uses `getContentFnRef`, the exact function the
   * autosave path serializes with. Verifying against anything else would check
   * a value that never reaches disk.
   */
  const applyVerifiedReload = useCallback((incoming: string): ReloadOutcome => {
    const editor = editorRef.current;
    const canUseLexical =
      !!editor && typeof editor.update === 'function' && typeof editor.getEditorState === 'function';
    const canUseSetContent = !!editor && typeof editor.setContent === 'function';

    let applyToEditor: ((content: string) => void) | null = null;
    if (canUseLexical && isMarkdown) {
      applyToEditor = (content) => {
        const transformers = getEditorTransformers();
        editor!.update(() => {
          // Clearing a selected node without moving selection first makes
          // Lexical throw "selection has been lost ..." (NIM-2005).
          $setSelection(null);
          const root = $getRoot();
          root.clear();
          $convertFromEnhancedMarkdownString(content, transformers);
        }, { tag: externalContentUpdateTags(editor) });
        setReloadVersion((v) => v + 1);
      };
    } else if (canUseSetContent) {
      applyToEditor = (content) => {
        editor!.setContent(content);
        setReloadVersion((v) => v + 1);
      };
    }

    return reloadFromDisk(
      incoming,
      {
        baseline: lastSavedContentRef.current,
        buffer: contentRef.current,
        dirty: isDirtyRef.current,
      },
      {
        applyToEditor,
        readBuffer: () => {
          const getContent = getContentFnRef.current;
          if (!getContent) return null;
          try {
            return getContent();
          } catch {
            return null;
          }
        },
        onApplyError: (error) => {
          logger.ui.error(`[TabEditor] Failed to apply external file change to ${fileName}:`, error);
        },
      },
    );
  }, [isMarkdown, fileName]);

  /**
   * Adopt a reload outcome. A verified apply moves the baseline, the buffer and
   * the dirty flag together. An unverified one moves none of them, blocks
   * writes, and hands off to self-heal -- the tab is wrong, not the disk.
   */
  const commitReloadOutcome = useCallback((outcome: ReloadOutcome, incoming: string) => {
    contentRef.current = outcome.next.buffer;
    initialContentRef.current = outcome.next.buffer;

    if (outcome.verified) {
      lastSavedContentRef.current = outcome.next.baseline;
      isDirtyRef.current = outcome.next.dirty;
      onDirtyChange?.(outcome.next.dirty);
      unverifiedReloadRef.current = null;
      setAutosaveConflictDiskContent(null);
      if (outcome.normalized) {
        logger.ui.info(
          `[TabEditor] Reload verified via normalized render (formatting differs from disk): ${fileName}`,
        );
      }
      return;
    }

    // Baseline deliberately untouched: it still describes content this buffer
    // can honestly be compared against, so Layer D keeps working.
    const attempts = (unverifiedReloadRef.current?.attempts ?? 0) + 1;
    unverifiedReloadRef.current = { incoming, attempts };
    logger.ui.warn(
      `[TabEditor] Reload could not be verified (${outcome.failure}), attempt ${attempts}; ` +
        `writes blocked for ${fileName} until it heals`,
    );
    scheduleSelfHealRef.current?.(attempts);
  }, [fileName, onDirtyChange]);

  // Self-heal is defined below (it re-reads disk and calls back into the two
  // functions above); this ref breaks the cycle without a dynamic import.
  const scheduleSelfHealRef = useRef<((attempts: number) => void) | null>(null);

  /**
   * Retry an unverified reload from a *fresh* disk read, on a bounded backoff.
   *
   * Re-reading matters: the content we failed to apply may itself be what the
   * editor choked on, and disk may have moved on again since. The goal is that
   * a blocked tab is a transient nobody sees -- see the plan's "avoid stale
   * tabs at all cost" decision. Only on exhaustion does the user get the
   * existing conflict banner, with writes still blocked so the tab is inert
   * rather than dangerous.
   */
  const SELF_HEAL_MAX_ATTEMPTS = 4;
  const scheduleSelfHeal = useCallback((attempts: number) => {
    if (selfHealTimerRef.current) clearTimeout(selfHealTimerRef.current);

    if (attempts >= SELF_HEAL_MAX_ATTEMPTS) {
      const pending = unverifiedReloadRef.current;
      logger.ui.error(
        `[TabEditor] Reload self-heal exhausted after ${attempts} attempts for ${fileName}; ` +
          `surfacing conflict banner, writes stay blocked`,
      );
      if (pending) setAutosaveConflictDiskContent(pending.incoming);
      return;
    }

    const delay = 150 * 2 ** (attempts - 1);
    selfHealTimerRef.current = setTimeout(async () => {
      selfHealTimerRef.current = null;
      if (!unverifiedReloadRef.current) return;
      try {
        const result = await window.electronAPI.readFileContent(filePath);
        if (!result?.success || typeof result.content !== 'string') return;
        if (!unverifiedReloadRef.current) return;
        isApplyingExternalContentRef.current = true;
        const outcome = applyVerifiedReload(result.content);
        commitReloadOutcome(outcome, result.content);
        setTimeout(() => {
          isApplyingExternalContentRef.current = false;
        }, 0);
      } catch (error) {
        logger.ui.error(`[TabEditor] Reload self-heal read failed for ${filePath}:`, error);
      }
    }, delay);
  }, [filePath, fileName, applyVerifiedReload, commitReloadOutcome]);

  useEffect(() => {
    scheduleSelfHealRef.current = scheduleSelfHeal;
  }, [scheduleSelfHeal]);

  useEffect(() => () => {
    if (selfHealTimerRef.current) clearTimeout(selfHealTimerRef.current);
  }, []);

  /**
   * Write the outcome of a diff resolution (accept, reject, partial) to disk.
   *
   * All six of these call sites used to pass `undefined` for `lastKnownContent`,
   * which switches the conflict check off entirely (#3684). The honest baseline
   * here is not the pre-diff content but the agent's write, which is what disk
   * holds while a diff is pending -- so a *second* agent write landing after the
   * diff was computed is now caught instead of being discarded silently by a
   * reject. On conflict this surfaces the existing banner and aborts rather
   * than throwing, matching the source-mode flush path.
   *
   * Returns true when the bytes reached disk.
   */
  const saveDiffResolutionToDisk = useCallback(async (
    content: string,
    clearDiffState?: () => void,
  ): Promise<boolean> => {
    const outcome = await resolveDiffResolutionSave(content, {
      readDiffBaseline: () => documentModel?.getDiffState()?.newContent,
      fallbackBaseline: lastSavedContentRef.current,
      clearDiffState,
      saveFile: (toWrite, lastKnown) =>
        window.electronAPI.saveFile(toWrite, filePath, lastKnown, 'manual'),
    });

    if (outcome.kind === 'conflict') {
      logger.ui.warn(
        `[TabEditor] Diff resolution refused for ${fileName}: disk changed since the diff was computed`,
      );
      setAutosaveConflictDiskContent(outcome.diskContent);
      return false;
    }
    if (outcome.kind === 'failed') {
      assertManualSaveSucceeded(outcome.result);
      return false;
    }
    return true;
  }, [filePath, fileName, documentModel, assertManualSaveSucceeded]);

  /**
   * How this tab is presenting the generation the model currently holds.
   *
   * A reported outcome only speaks for the generation it named: if the model has
   * moved on (or this tab never reported at all), the presentation is unverified
   * and must block, not settle.
   */
  const currentPresentationMode = useCallback((): DiffPresentationMode => {
    if (!pendingAIEditTagRef.current) return 'none';
    if (sourceModeRef.current) return 'source-deferred';
    const generation = documentModel?.getDiffState()?.generation;
    const reported = presentedGenerationRef.current;
    if (generation === undefined || !reported || reported.generation !== generation) {
      return 'failed';
    }
    return reported.mode;
  }, [documentModel]);

  /**
   * A resolution serializes the buffer and writes it, which is only honest once
   * the buffer has stopped moving. A click can land inside the settle window of
   * the apply that rendered the very diff the user acted on, so wait it out
   * rather than refusing. Bounded: an apply that never finishes must not hang
   * the user's decision.
   *
   * Returns false when the buffer is still in flight after the bound.
   */
  const waitForDiffApplyToSettle = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + 2000;
    while (isApplyingDiffRef.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !isApplyingDiffRef.current;
  }, []);

  /** Whether the editor still shows diff nodes right now. */
  const editorStillShowsDiff = useCallback((): boolean => {
    const current = editorRef.current;
    if (!current || typeof current.getEditorState !== 'function') return false;
    return current.getEditorState().read(() => $hasDiffNodes(current));
  }, []);

  /**
   * End the review through the model's single-flight resolution.
   *
   * The disk write and the history-tag update are one ordered transaction there,
   * serialized against watcher delivery. Sequencing them here instead -- write,
   * then tag, then clear the model's state -- read the conflict baseline outside
   * that queue: an agent write landing in between was handed to the store as the
   * *expected* disk content, so the stale buffer overwrote it with a conflict
   * check that passed (NIM-5359, finding 1).
   *
   * `finalContent` is this editor's own serialization when it has one (a Lexical
   * accept-all after per-group decisions). `generation` is the model generation
   * that was live when the decision arrived; the model refuses outright if the
   * agent has written again since, leaving the review open over the content the
   * user has not seen yet.
   *
   * Returns false when the decision was refused -- callers must leave their diff
   * UI up and write nothing.
   */
  const resolveReviewThroughModel = useCallback(async (
    accepted: boolean,
    request: { finalContent?: string; generation?: number } = {},
  ): Promise<boolean> => {
    const handle = documentModelHandleRef.current;
    if (!handle || !documentModel?.getDiffState()) {
      logger.ui.warn(`[TabEditor] No model diff state to resolve for ${fileName}`);
      return false;
    }
    try {
      await handle.resolveDiff(accepted, request);
    } catch (err) {
      logger.ui.warn(
        `[TabEditor] Diff resolution refused for ${fileName}; leaving the review open:`,
        err,
      );
      return false;
    }
    return true;
  }, [documentModel, fileName]);

  /**
   * Decide whether an autosave may proceed while an AI edit tag is pending.
   *
   * Between `$approveDiffs` removing the diff nodes and `CLEAR_DIFF_TAG_COMMAND`
   * arriving there is a window -- a 100ms timer plus several IPC round-trips --
   * where the tab looks like an ordinary dirty buffer but disk holds the
   * agent's write and `lastSavedContentRef` still holds the pre-AI content. An
   * autosave landing there is refused as a conflict and raises the banner on a
   * change the user just accepted (#1408). Same shape when the user resolves
   * every diff by hand instead.
   *
   * So: never race a resolution that is already in flight, and when this is the
   * thing that ends diff mode, adopt the agent's content as the baseline before
   * dropping the diff state that names it.
   *
   * The decision table itself is `resolveDiffAutosaveGate`, which is where "no
   * inline diff" stops being confusable with "manually resolved".
   */
  const settleDiffBeforeAutosave = useCallback(async (): Promise<'proceed' | 'skip'> => {
    if (isClearingDiffTagRef.current) return 'skip';

    // A resolution already wrote its bytes but could not mark the tag reviewed.
    // Until that half lands, nothing may be written on top of it.
    if (documentModel?.isSaveBlockedByPendingResolution()) {
      logger.ui.warn(`[TabEditor] Autosave blocked: diff resolution tag still pending for ${fileName}`);
      return 'skip';
    }

    const pending = pendingAIEditTagRef.current;
    const editor = editorRef.current;
    const canReadDiffNodes = !!editor && typeof editor.getEditorState === 'function';
    const modelDiskContent = documentModel?.getDiffState()?.newContent ?? null;

    const decision = resolveDiffAutosaveGate({
      hasPendingTag: !!pending,
      resolutionInFlight: documentModel?.isResolutionInFlight() ?? false,
      presentation: currentPresentationMode(),
      hasDiffNodes: canReadDiffNodes
        ? editor.getEditorState().read(() => $hasDiffNodes(editor))
        : null,
      modelDiskContent,
    });

    if (decision.kind === 'proceed') return 'proceed';
    if (decision.kind === 'skip') {
      // Not a warning: most of these are the ordinary "the review is still open"
      // state that fires on every autosave tick.
      logger.ui.debug(`[TabEditor] Autosave held for ${fileName}: ${decision.reason}`);
      return 'skip';
    }

    // `settle`: the user reduced a rendered inline diff to zero groups by hand.
    const diskBaseline = decision.adoptedBaseline;
    if (typeof diskBaseline === 'string') {
      lastSavedContentRef.current = diskBaseline;
      documentModel?.setLastPersistedContent(diskBaseline);
    }

    logger.ui.info(`[TabEditor] No diffs remaining, clearing pending tag: ${fileName}`);

    // End the review through the model's awaited resolution: the disk write and
    // the tag update are one ordered, recoverable transaction there. The old
    // fire-and-forget `history:update-tag-status` IPC could fail silently, which
    // left the baseline on disk under a still-pending tag (NIM-5359, defect I).
    const handle = documentModelHandleRef.current;
    if (handle && documentModel?.getDiffState()) {
      try {
        await handle.resolveDiff(true);
      } catch (err) {
        logger.ui.warn(
          `[TabEditor] Diff resolution before autosave failed for ${fileName}; holding the write:`,
          err,
        );
        return 'skip';
      }
      setPendingAIEditTag(null);
      return 'proceed';
    }

    // The model's diff state went away between the gate and here -- its
    // resolution already ran, and the baseline above is the one it wrote. All
    // that is left is the tag. (A settle decision requires model disk truth, so
    // this can no longer be the mount path's "diff mode without a model".)
    if (!pending) return 'proceed';
    try {
      await window.electronAPI.invoke('history:update-tag-status', pending.filePath, pending.tagId, 'reviewed');
    } catch (err) {
      logger.ui.warn(`[TabEditor] Clearing pending tag failed for ${fileName}; holding the write:`, err);
      return 'skip';
    }
    setPendingAIEditTag(null);
    // Exclude self from the diffResolved fan-out -- siblings still need to
    // exit diff mode, but we already did our local cleanup.
    documentModel?.clearDiffState(documentModelHandleRef.current?.id, true);
    return 'proceed';
  }, [documentModel, fileName, currentPresentationMode, setPendingAIEditTag]);

  const settleDiffBeforeAutosaveRef = useRef(settleDiffBeforeAutosave);
  useEffect(() => {
    settleDiffBeforeAutosaveRef.current = settleDiffBeforeAutosave;
  }, [settleDiffBeforeAutosave]);

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
    //
    // This is the one keystroke that could reproduce the whole NIM-5359
    // incident: it used to approve whatever diff nodes it found -- none, if an
    // apply was mid-flight with the buffer reset to the pre-edit baseline --
    // clear the model's state, fire an un-awaited tag update, and write that
    // baseline over the agent's content with a conflict check that passed. So
    // the review is settled first, through the model, and only a generation
    // this tab verifiably rendered may be settled at all (finding 2).
    if (pendingAIEditTagRef.current || documentModel?.isSaveBlockedByPendingResolution()) {
      // Let an apply that is mid-flight finish rather than refusing a click
      // that landed a moment early.
      await waitForDiffApplyToSettle();

      // Same for a resolution another path already owns -- clicking Approve and
      // then hitting Cmd+S is ordinary. It owns the write; join it and then save
      // on top, rather than dropping the user's save on the floor.
      if (documentModel?.isResolutionInFlight()) {
        await documentModel.retryPendingResolution().catch(() => {});
      }

      const decision = resolveManualSaveReviewGate({
        // The model's diff state, not just this tab's ref: once the review is
        // resolved there is nothing left to gate, and the ref is cleared a tick
        // later by whoever resolved it.
        hasPendingTag: !!pendingAIEditTagRef.current && !!documentModel?.getDiffState(),
        resolutionInFlight: documentModel?.isResolutionInFlight() ?? false,
        resolutionIncomplete: documentModel?.isSaveBlockedByPendingResolution() ?? false,
        applyInFlight: isApplyingDiffRef.current,
        presentation: currentPresentationMode(),
      });

      if (decision.kind === 'refuse') {
        logger.ui.warn(
          `[TabEditor] Manual save held for ${fileName}: ${decision.reason}. ` +
            `The buffer is preserved and the review stays open.`,
        );
        return;
      }

      if (decision.kind === 'resolve-then-save') {
        const editor = editorRef.current;
        if (!editor || typeof editor.update !== 'function' || !getContentFnRef.current) {
          logger.ui.warn(
            `[TabEditor] Manual save held for ${fileName}: no editor to settle the review with`,
          );
          return;
        }
        logger.ui.info(`[TabEditor] Approving diffs before manual save for ${fileName}`);
        // Captured before the approve: the decision belongs to the generation
        // that was live when the keystroke arrived, not to whatever the agent
        // publishes while we serialize.
        const decidedGeneration = documentModel?.getCurrentDiffGeneration() ?? undefined;
        editor.update(() => {
          $approveDiffs();
        });
        const approvedContent = getContentFnRef.current();
        if (!(await resolveReviewThroughModel(true, {
          finalContent: approvedContent,
          generation: decidedGeneration,
        }))) {
          return;
        }
        setPendingAIEditTag(null);
        lastSavedContentRef.current = approvedContent;
        contentRef.current = approvedContent;
        initialContentRef.current = approvedContent;
      }
    }

    if (!getContentFnRef.current) return;
    const currentContent = getContentFnRef.current();
    // Use skipDiffCheck=false so saveWithHistory checks for leftover diff nodes
    // and clears pending tags if all diffs have been resolved
    try {
      await saveWithHistory(currentContent, 'manual', false);
    } catch (error) {
      logger.ui.error(`[TabEditor] Manual save failed for ${filePath}:`, error);
    }
  }, [
    saveWithHistory,
    fileName,
    filePath,
    documentModel,
    waitForDiffApplyToSettle,
    currentPresentationMode,
    resolveReviewThroughModel,
    setPendingAIEditTag,
  ]);

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

    if (documentModel) cleanups.push(documentModel.on('external-conflict', event => {
      if (isDirtyRef.current && typeof event.diskContent === 'string') setAutosaveConflictDiskContent(event.diskContent);
    }));

    // --- Autosave: DocumentModel calls onSaveRequested when it's time to save ---
    // Custom editors wire their own callback via EditorHost.subscribeToSaveRequests.
    // This handler covers built-in editors (Lexical/Monaco) that use getContentFnRef.
    // If a custom editor has already registered via EditorHost, skip (checked at call time).
    cleanups.push(
      handle.onSaveRequested(async () => {
        // Custom editors handle their own save via EditorHost callback
        if (editorHostSaveRequestCallbackRef.current) return;
        // Skip if no content function (editor not ready)
        if (!getContentFnRef.current) return;
        // Skip if applying a diff
        if (isApplyingDiffRef.current) return;
        // #3684: the buffer is not a verified picture of this file. Writing it
        // would silently revert whoever last wrote to disk. Self-heal is
        // already retrying; stay inert until it clears.
        if (unverifiedReloadRef.current) {
          logger.ui.warn(`[TabEditor] Autosave blocked: reload unverified for ${fileName}`);
          return;
        }

        // If in diff mode, check if all diffs have been manually resolved.
        // (User may have deleted all diff content via select-all + backspace.)
        // If no diff nodes remain, clear the pending tag so autosave can proceed.
        if ((await settleDiffBeforeAutosaveRef.current()) === 'skip') return;
        // The gate above awaits a resolution; re-check the editor is still here.
        if (!getContentFnRef.current) return;

        const currentContent = getContentFnRef.current();
        logger.ui.info(`[TabEditor] DocumentModel autosave: ${fileName}`);
        return saveWithHistory(currentContent, 'auto').catch((err) => {
          logger.ui.error(`[TabEditor] DocumentModel autosave failed for ${filePath}:`, err);
          throw err;
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
          return false;
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

        // The baseline, the buffer and the dirty flag move together or not at
        // all -- see reloadFromDisk.ts for why an unverified baseline is a
        // silent data-loss path (#3684).
        const outcome = applyVerifiedReload(content);
        commitReloadOutcome(outcome, content);

        setTimeout(() => {
          isApplyingExternalContentRef.current = false;
        }, 0);
        return outcome.verified;
      }),
    );

    // --- Diff mode: DocumentModel calls onDiffRequested only when there's new work ---
    //
    // DocumentModel runs the DiffSession state machine. It only fires onDiffRequested
    // when the session transitions to `applying` with a fresh payload. Duplicates and
    // in-flight queues are handled inside the model -- we just apply whatever shows up.
    // After the editor settles we report the outcome for the exact generation we
    // were handed via `handle.completeDiffApply`. The model drains the next
    // payload only once every recipient of that generation reports success; a
    // `failed` outcome makes it re-read disk instead of advancing the baseline
    // onto content nothing is showing (NIM-5359, defects F/G).
    const applyDiffState = async (state: DiffState): Promise<void> => {
      const { tagId, sessionId, oldContent, newContent, createdAt, generation } = state;
      const tagInfo = { tagId, sessionId, filePath };

      // Exactly one outcome per generation, and never from `finally` -- that is
      // what let a caught apply error acknowledge success.
      let reported = false;
      const report = (outcome: DiffApplyOutcome): void => {
        if (reported) return;
        reported = true;
        // The same outcome the model gets is what the autosave gate reads back:
        // "zero diff nodes" only means "the user resolved this" for a generation
        // this tab verifiably rendered inline.
        presentedGenerationRef.current = {
          generation,
          mode: PRESENTATION_FOR_OUTCOME[outcome],
        };
        try {
          handle.completeDiffApply({ generation, outcome });
        } catch (err) {
          logger.ui.error('[TabEditor] completeDiffApply failed:', err);
        }
      };

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
          report('applied');
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
            // The resolution IS this editor's completion: the session is gone, so
            // a generic apply acknowledgement would name a generation that no
            // longer exists.
            reported = true;
            // resolveDiff's notifyFileChanged fired while our diff guards were
            // still set, so the subscribeToFileChanges wrapper dropped it -- and
            // onDiffResolved excludes the resolving editor, so nothing else
            // clears the pending tag. Without these two lines the open custom
            // editor never sees this edit and stays deaf to every subsequent
            // file change until the tab is reopened (NIM-1484).
            setPendingAIEditTag(null);
            editorHostFileChangeCallbackRef.current?.(newContent);
          } catch (err) {
            logger.ui.error('[TabEditor] Auto-accept diff failed for no-diff-view custom editor:', err);
            report('failed');
          }
        } else if (isCustom) {
          // A diff-capable custom editor whose own callback has not landed yet.
          // Registration is the readiness signal, so park the generation instead
          // of claiming it: `subscribeToDiffRequests` re-registers this
          // attachment as a presenter and the model replays the latest target
          // through `onPresenterRegistered` (NIM-5359 Phase 6, replacing the
          // mount path's 50ms sleep).
          report('detached');
        } else {
          // Built-in editor: Lexical or Monaco
          contentRef.current = oldContent;

          if (!editorRef.current) {
            // Nothing here can present the generation. Claiming it applied would
            // advance the model past content no editor is showing; reporting
            // `detached` parks it until this attachment re-registers with a
            // mounted editor.
            report('detached');
          } else {
            if (isMarkdown) {
              const transformers = getEditorTransformers();

              // #4821: the tree matcher's O(m*n) alignment is unaffordable above
              // these thresholds -- tens of seconds of blocked main thread, then
              // a throw. Declining it is a PRESENTATION outcome: the buffer gets
              // the agent's bytes (verified), the approval bar and the pending
              // tag stay, and the model is told `presented-without-inline` so
              // autosave cannot read the missing diff nodes as a resolution.
              const presentWithoutInline = (reason: string): void => {
                logger.ui.warn(`[TabEditor] Skipping Lexical diff: ${reason} file=${fileName}`);
                isApplyingExternalContentRef.current = true;
                const outcome = applyVerifiedReload(newContent);
                commitReloadOutcome(outcome, newContent);
                setTimeout(() => {
                  isApplyingExternalContentRef.current = false;
                }, 0);
                // The restore round-trip is a reparse, not a user edit -- don't
                // let the trailing Lexical onChange leave the tab dirty.
                setTimeout(() => {
                  isDirtyRef.current = false;
                  onDirtyChange?.(false);
                }, 100);
                fetchDiffSessionInfo(sessionId, createdAt);
                if (!outcome.verified) {
                  // commitReloadOutcome already blocked writes and started
                  // self-heal; the model must recover rather than move on.
                  report('failed');
                  return;
                }
                setNoInlineFallbackReview(true);
                report('presented-without-inline');
              };

              const byBytes = decideLexicalDiffByBytes(oldContent, newContent);
              if (byBytes.presentation === 'no-inline-fallback') {
                presentWithoutInline(byBytes.reason);
                return;
              }

              diffTrace('TabEditor.applyDiffState resetting editor to oldContent', { filePath, oldLen: oldContent.length, t: performance.now() });
              let oldRootNodeCount = 0;
              editorRef.current.update(() => {
                // Clearing a selected node without moving selection first makes
                // Lexical throw "selection has been lost ..." (NIM-2005).
                $setSelection(null);
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(oldContent, transformers);
                oldRootNodeCount = root.getChildren().length;
              }, { tag: externalContentUpdateTags(editorRef.current) });

              // Bytes are only a pre-filter -- 194KB of prose is a handful of
              // nodes, 194KB of bullets is thousands -- so the real guard runs
              // once the baseline is parsed. The buffer currently holds the
              // baseline; the fallback puts the agent's bytes back.
              const byRootNodes = decideLexicalDiffByRootNodes(oldRootNodeCount);
              if (byRootNodes.presentation === 'no-inline-fallback') {
                presentWithoutInline(byRootNodes.reason);
                return;
              }

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

              // #3684 (hole 2): we have just reset the buffer to `oldContent`
              // while disk holds `newContent`. That is only safe if the diff
              // actually rendered -- the autosave guard skips saving while diff
              // nodes exist. If the replace command produced none, nothing is
              // holding autosave back and it would write `oldContent` over the
              // agent's write, byte-identically. Block instead; self-heal will
              // re-read disk and put the tab back on real content.
              const diffRendered = editorRef.current.getEditorState().read(() =>
                $hasDiffNodes(editorRef.current!),
              );
              if (!diffRendered && newContent !== oldContent) {
                logger.ui.error(
                  `[TabEditor] Diff produced no nodes for ${fileName}; buffer holds pre-edit content ` +
                    `while disk holds the new content. Blocking writes and self-healing.`,
                );
                unverifiedReloadRef.current = {
                  incoming: newContent,
                  attempts: (unverifiedReloadRef.current?.attempts ?? 0) + 1,
                };
                scheduleSelfHealRef.current?.(unverifiedReloadRef.current.attempts);
                // The readback is the proof. Without it the target is not on
                // screen, so the model must recover it rather than move on.
                report('failed');
              } else {
                report('applied');
              }
            } else if (editorRef.current.showDiff) {
              editorRef.current.showDiff(oldContent, newContent);
              setShowMonacoDiffBar(true);
              fetchDiffSessionInfo(sessionId, createdAt);
              report('applied');
            } else {
              // A built-in editor with no diff surface at all. The bytes are on
              // disk and the approval bar stays pending; there is simply no
              // inline rendering to verify.
              report('presented-without-inline');
            }
          }

          isDirtyRef.current = false;
          onDirtyChange?.(false);
          setReloadVersion((v) => v + 1);
        }
      } catch (error) {
        logger.ui.error(`[TabEditor] Failed to apply DocumentModel diff:`, error);
        report('failed');
      } finally {
        isApplyingDiffRef.current = false;
        // Backstop only: every branch above names its own outcome. An unreported
        // generation means we fell through a path that presented nothing, and
        // `failed` is the outcome that cannot advance the conflict baseline.
        report('failed');
      }
    };

    // Registering the callback is what makes this attachment a generation
    // recipient, so the two cases that cannot present must not register:
    //
    // - source mode, which renders raw text and no diff at all. `sourceMode` is
    //   in this effect's dependencies precisely so entry unregisters and exit
    //   re-registers, and the re-registration is what republishes the parked
    //   generation through the model's `onPresenterRegistered`.
    // - a diff-capable custom editor whose own diff callback has not arrived.
    //   Its registration is the readiness signal (this effect re-runs on it),
    //   which is what replaced the mount path's 50ms sleep.
    //
    // Either way the model parks the generation as `awaiting-presenter` rather
    // than waiting on an acknowledgement that cannot come (NIM-5359 Phase 6).
    const canPresentDiffs =
      !sourceMode && (!isCustom || !customEditorSupportsDiffMode || customDiffPresenterReady);

    if (canPresentDiffs) cleanups.push(
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
          // There is nothing to render, but the buffer already equals the target,
          // so the generation is honestly presented -- naming that outcome keeps
          // the session from sitting in 'applying' with nobody owing it anything.
          presentedGenerationRef.current = {
            generation: diffState.generation,
            mode: 'presented-without-inline',
          };
          handle.completeDiffApply({
            generation: diffState.generation,
            outcome: 'presented-without-inline',
          });
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
    // `sourceMode` and `customDiffPresenterReady` are here so presenter
    // registration follows readiness deterministically -- see `canPresentDiffs`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filePath,
    fileName,
    isMarkdown,
    isCustom,
    saveWithHistory,
    isEditorReady,
    sourceMode,
    customEditorSupportsDiffMode,
    customDiffPresenterReady,
  ]);


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
                // Clearing a selected node without moving selection first makes
                // Lexical throw "selection has been lost ..." (NIM-2005).
                $setSelection(null);
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
            // Clearing a selected node without moving selection first makes
            // Lexical throw "selection has been lost ..." (NIM-2005).
            $setSelection(null);
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
              // Clearing a selected node without moving selection first makes
              // Lexical throw "selection has been lost ..." (NIM-2005).
              $setSelection(null);
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

    // `waitForDiffApplyToSettle` and `editorStillShowsDiff` are component-level:
    // manual save applies the same two checks before it may settle a review.

    // Handle incremental approval - create tag for partial accept/reject
    const handleIncrementalApproval = async () => {
      try {
        if (!pendingAIEditTagRef.current) {
          return;
        }
        // The generation this decision belongs to, read before anything awaits.
        const decidedGeneration = documentModel?.getCurrentDiffGeneration() ?? undefined;
        // A partial decision deliberately leaves the other groups on screen, so
        // only the mid-apply wait applies here.
        if (!(await waitForDiffApplyToSettle())) {
          logger.ui.warn(
            `[TabEditor] Ignoring partial diff resolution for ${fileName}: the buffer is still mid-apply`,
          );
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

          // A partial resolve rotates the tag rather than ending the session, so
          // it does not go through the model's resolution transaction -- but it
          // still may not write a buffer the agent has already outrun.
          if (documentModel?.getCurrentDiffGeneration() !== decidedGeneration) {
            logger.ui.warn(
              `[TabEditor] Ignoring partial diff resolution for ${fileName}: the agent wrote again ` +
                `while the decision was being serialized`,
            );
            return;
          }

          // Save the approved content to disk
          if (!(await saveDiffResolutionToDisk(approvedContent))) return;

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

          // Update our state. The model's baseline has to move with the local
          // one -- leaving it on the pre-AI content makes the next external
          // change look like a divergence the model has to hold the line on.
          contentRef.current = approvedContent;
          lastSavedContentRef.current = approvedContent;
          documentModel?.setLastPersistedContent(approvedContent);
        }
      } catch (error) {
        logger.ui.error('[TabEditor] Failed to create incremental-approval tag:', error);
      }
    };

    // Handle clearing diff tag without accept/reject (for incremental operations)
    const handleClearDiffTag = async () => {
      // The generation this decision belongs to: read before the waits below, so
      // anything the agent publishes while we settle and serialize makes the
      // model refuse rather than accept a buffer that predates it.
      const decidedGeneration = documentModel?.getCurrentDiffGeneration() ?? undefined;
      // This command means "every group is resolved", so diff nodes surviving
      // the wait mean the decision never reached this buffer: the click landed
      // while an apply had it on the pre-edit baseline with nothing rendered
      // (the ~350ms a recovery republish opens), and the approve was a no-op.
      // Serializing now writes that baseline over the agent's content --
      // byte-for-byte the NIM-5359 incident. Leave the review pending instead.
      if (!(await waitForDiffApplyToSettle()) || editorStillShowsDiff()) {
        logger.ui.warn(
          `[TabEditor] Ignoring diff resolution for ${fileName}: the buffer is mid-apply and still ` +
            `holds an unrendered generation`,
        );
        return;
      }
      isClearingDiffTagRef.current = true;
      try {
        if (!pendingAIEditTagRef.current) {
          logger.ui.warn('[TabEditor] handleClearDiffTag called but no pendingAIEditTagRef');
          return;
        }

        const { tagId, sessionId: clearSessionId, filePath } = pendingAIEditTagRef.current;
        logger.ui.info('[TabEditor] handleClearDiffTag START:', { tagId, filePath });

        // The write, the tag update and the session teardown all belong to the
        // model: it holds them on one serial queue, with the agent's latest
        // write as the conflict baseline. This used to be three steps here --
        // tag first, then a write whose baseline was read from the model
        // afterwards -- so an agent write arriving in between was handed over as
        // the expected disk content and this buffer overwrote it clean
        // (NIM-5359, finding 1).
        if (editorRef.current) {
            const transformers = getEditorTransformers();

            const currentContent = editorRef.current.getEditorState().read(() => {
              return $convertToEnhancedMarkdownString(transformers);
            });

            if (!(await resolveReviewThroughModel(true, {
              finalContent: currentContent,
              generation: decidedGeneration,
            }))) return;

            // Clear the pending tag reference so the file watcher won't re-enter
            // diff mode. After the resolution, so the model's own
            // notifyFileChanged is still suppressed locally.
            setPendingAIEditTag(null);

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
          } else {
            // No editor to serialize: the model resolves from the session's own
            // accepted content, and siblings still leave diff mode.
            if (!(await resolveReviewThroughModel(true, { generation: decidedGeneration }))) return;
            setPendingAIEditTag(null);
          }

          // Reload editor to exit diff mode and show clean final state
          const result = await window.electronAPI.readFileContent(filePath);
          if (result && result.success) {
            const finalContent = result.content;

            if (editorRef.current) {
              const transformers = getEditorTransformers();

              // This reparse is the resolution's own bytes coming back, not a
              // user edit. Without the guard the tab is left showing "unsaved
              // changes" the moment a review is approved, and whether that
              // clears at all depends on a save happening to land afterwards.
              isApplyingExternalContentRef.current = true;
              editorRef.current.update(() => {
                // Clearing a selected node without moving selection first makes
                // Lexical throw "selection has been lost ..." (NIM-2005).
                $setSelection(null);
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(finalContent, transformers);
              }, { tag: SKIP_SCROLL_INTO_VIEW_TAG });
              isDirtyRef.current = false;
              documentModelHandleRef.current?.setDirty(false);
              onDirtyChange?.(false);
              setTimeout(() => {
                isApplyingExternalContentRef.current = false;
              }, 0);
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

      // The generation this click belongs to, before anything awaits.
      const decidedGeneration = documentModel?.getCurrentDiffGeneration() ?? undefined;

      // console.log('[TabEditor] ABOUT TO CALL acceptDiff');
      // Get the new content from Monaco diff editor
      const newContent = editorRef.current.acceptDiff();
      // console.log('[TabEditor] acceptDiff RETURNED:', newContent.length);

      // Bytes and tag as one model-owned transaction; see resolveReviewThroughModel.
      if (!(await resolveReviewThroughModel(true, {
        finalContent: newContent,
        generation: decidedGeneration,
      }))) return;

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

      // The model already tore the session down and delivered `newContent` to
      // sibling attachments as part of the resolution above.

      logger.ui.info('[TabEditor] Monaco diff accepted successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error accepting Monaco diff:', error);
    }
  }, [filePath, documentModel, resolveReviewThroughModel, setPendingAIEditTag]);

  const handleMonacoDiffReject = useCallback(async () => {
    if (!editorRef.current?.rejectDiff || !pendingAIEditTagRef.current) {
      logger.ui.warn('[TabEditor] Cannot reject Monaco diff - no editor or pending tag');
      return;
    }

    try {
      logger.ui.info('[TabEditor] Rejecting Monaco diff');

      // The generation this click belongs to, before anything awaits.
      const decidedGeneration = documentModel?.getCurrentDiffGeneration() ?? undefined;

      // Get the old content from Monaco diff editor
      const oldContent = editorRef.current.rejectDiff();

      // Bytes and tag as one model-owned transaction; see resolveReviewThroughModel.
      if (!(await resolveReviewThroughModel(false, {
        finalContent: oldContent,
        generation: decidedGeneration,
      }))) return;

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

      // The model already tore the session down and delivered the restored
      // content to sibling attachments as part of the resolution above.

      logger.ui.info('[TabEditor] Monaco diff rejected successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error rejecting Monaco diff:', error);
    }
  }, [filePath, documentModel, resolveReviewThroughModel, setPendingAIEditTag]);

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

      // The custom editor already has the modified content displayed, so the
      // model resolves from the session's own accepted content. It still goes
      // through the model rather than a bare tag update: the generation check is
      // what stops this click from ending a review of content the agent wrote
      // after the bar was drawn (NIM-5359, finding 1).
      if (!(await resolveReviewThroughModel(true, {
        generation: documentModel?.getCurrentDiffGeneration() ?? undefined,
      }))) return;

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

      // Sibling attachments left diff mode as part of the model's resolution.

      logger.ui.info('[TabEditor] Custom editor diff accepted successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error accepting custom editor diff:', error);
    }
  }, [filePath, workspaceId, documentModel, resolveReviewThroughModel, setPendingAIEditTag]);

  const handleCustomEditorDiffReject = useCallback(async () => {
    if (!pendingAIEditTagRef.current) {
      logger.ui.warn('[TabEditor] Cannot reject custom editor diff - no pending tag');
      return;
    }

    try {
      logger.ui.info('[TabEditor] Rejecting custom editor diff');

      // The session's own baseline is the content to restore -- the same value
      // `history:get-diff-baseline` returns, but read from the state the user is
      // actually looking at, and rolled back by the model as one transaction
      // with the tag update.
      const rejectedState = documentModel?.getDiffState();
      if (!rejectedState) {
        logger.ui.error('[TabEditor] Cannot reject - no model diff state');
        return;
      }
      const restoredContent = rejectedState.oldContent;
      if (!(await resolveReviewThroughModel(false, {
        generation: documentModel?.getCurrentDiffGeneration() ?? undefined,
      }))) return;

      // Snapshot the restored content and advance the Codex cache baseline
      await window.electronAPI.invoke('history:create-snapshot', filePath, restoredContent, 'manual', 'Diff rejected');
      const rejectedSessionId = pendingAIEditTagRef.current?.sessionId;
      if (rejectedSessionId) {
        window.electronAPI.invoke('ai:advance-diff-baseline', rejectedSessionId, filePath, restoredContent);
      }

      // Clear pending tag ref
      setPendingAIEditTag(null);

      // Hide the diff approval bar and clear session info
      setShowCustomEditorDiffBar(false);
      setDiffSessionInfo(null);

      // Notify the custom editor that diff mode has ended
      // The editor will reload content from disk via host.loadContent()
      diffClearedCallbackRef.current?.();

      // Sibling attachments left diff mode, and received the restored content,
      // as part of the model's resolution.

      logger.ui.info('[TabEditor] Custom editor diff rejected successfully');
    } catch (error) {
      logger.ui.error('[TabEditor] Error rejecting custom editor diff:', error);
    }
  }, [filePath, workspaceId, documentModel, resolveReviewThroughModel, setPendingAIEditTag]);

  /**
   * Accept/reject for a review that was deliberately presented without an
   * inline diff (#4821 large-document fallback). There is nothing on screen to
   * approve group by group, so both decisions go straight through the model's
   * single-flight resolution, which owns the disk write and the tag update as
   * one recoverable transaction.
   */
  const resolveNoInlineFallbackReview = useCallback(async (accepted: boolean) => {
    const handle = documentModelHandleRef.current;
    const state = documentModel?.getDiffState();
    if (!handle || !state) {
      logger.ui.warn(`[TabEditor] No model diff state to resolve for ${fileName}`);
      return;
    }
    const finalContent = accepted ? state.newContent : state.oldContent;
    try {
      await handle.resolveDiff(accepted);
    } catch (err) {
      logger.ui.error(`[TabEditor] Failed to resolve the no-inline review for ${fileName}:`, err);
      return;
    }
    setPendingAIEditTag(null);
    setDiffSessionInfo(null);
    // resolveDiff's notifyFileChanged fired while the pending tag was still set,
    // so onFileChanged dropped it and onDiffResolved excludes the resolver.
    // Put the resolved bytes in the buffer here, verified like any other reload.
    isApplyingExternalContentRef.current = true;
    commitReloadOutcome(applyVerifiedReload(finalContent), finalContent);
    setTimeout(() => {
      isApplyingExternalContentRef.current = false;
    }, 0);
  }, [documentModel, fileName, setPendingAIEditTag, applyVerifiedReload, commitReloadOutcome]);

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
    const refreshCurrentFileAfterProjectWrite = async (receipt: ProjectFileWriteReceipt): Promise<void> => {
      if (!receipt.files.some((entry) => normalizePathForCompare(entry.path) === normalizePathForCompare(filePath))) return;
      const result = await window.electronAPI.readFileContent(filePath);
      if (!result?.success || typeof result.content !== 'string') {
        throw new Error(`A project file write changed ${fileName}, but the editor could not reload it.`);
      }
      contentRef.current = result.content;
      initialContentRef.current = result.content;
      lastSavedContentRef.current = result.content;
      isDirtyRef.current = false;
      documentModel?.setLastPersistedContent(result.content);
      documentModelHandleRef.current?.setDirty(false);
      documentModelHandleRef.current?.notifySiblingsSaved(result.content);
      onDirtyChange?.(false);
      editorHostFileChangeCallbackRef.current?.(result.content);
    };

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
      getVisible: () => visibleRef.current,
      subscribeToVisibilityChanges: (callback: (visible: boolean) => void): (() => void) => {
        visibilityCallbacksRef.current.add(callback);
        return () => {
          visibilityCallbacksRef.current.delete(callback);
        };
      },
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
          // chain. Same guard TabEditor's own onSaveRequested handler applies,
          // so built-in editors honor diff mode too.
          if ((await settleDiffBeforeAutosaveRef.current()) === 'skip') return;
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

      ...(workspaceId && !filePath.startsWith('virtual://') ? {
        fs: createProjectFileSystemHost({
          onAfterWrite: refreshCurrentFileAfterProjectWrite,
        }) satisfies EditorHostFileSystem,
      } : {}),

      // Open only host-normalized HTTPS references outside the renderer.
      openExternal: (url: string) => window.electronAPI.openExternal(url),

      // Subscribe to diff requests (optional - for editors that support diff mode)
      subscribeToDiffRequests: customEditorSupportsDiffMode
        ? (callback: (config: DiffConfig) => void): (() => void) => {
            diffRequestCallbackRef.current = callback;
            // This is the readiness signal the mount path's 50ms sleep was
            // guessing at: it re-runs the DocumentModel subscription effect,
            // which registers this attachment as a presenter and makes the model
            // replay whatever generation is parked (NIM-5359 Phase 6).
            setCustomDiffPresenterReady(true);
            return () => {
              diffRequestCallbackRef.current = null;
              setCustomDiffPresenterReady(false);
            };
          }
        : undefined,

      // Report diff result
      reportDiffResult: customEditorSupportsDiffMode
        ? async (result): Promise<void> => {
            if (!pendingAIEditTagRef.current) return;

            // One model-owned transaction: the extension's resolved bytes with
            // the agent's latest write as the conflict baseline, then the tag.
            if (!(await resolveReviewThroughModel(true, {
              finalContent: result.content,
              generation: documentModel?.getCurrentDiffGeneration() ?? undefined,
            }))) return;

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
      // Cmd+F never reaches the renderer (native menu accelerator), so a custom
      // editor with its own find UI registers here and the find-command effect
      // below calls it.
      subscribeToFindRequests: (callback: () => void): (() => void) => {
        customEditorFindCallbackRef.current = callback;
        return () => {
          if (customEditorFindCallbackRef.current === callback) {
            customEditorFindCallbackRef.current = null;
          }
        };
      },

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
          // The toggle's own write bypasses saveWithHistory, so it needs the
          // same review gate: this buffer has never been shown the agent's
          // write, and flushing it would revert it.
          //
          // But the toggle then reloads from disk, so skipping the flush
          // silently destroys everything typed since the review opened -- text
          // that exists nowhere else. Neither side of that is ours to pick, so
          // ask. Cancel keeps the buffer and the editor exactly as they are
          // (NIM-5359, finding 3).
          if (hasUnresolvedReview()) {
            const discard = window.confirm(
              'An AI edit is still pending review, so these edits cannot be saved yet.\n\n' +
                'Switching editors reloads the file from disk and discards them.\n\n' +
                'Click OK to discard your edits, or Cancel to stay here and resolve the review first.',
            );
            if (!discard) {
              logger.ui.info(
                `[TabEditor] Editor-mode toggle cancelled for ${fileName}: unsaved edits kept`,
              );
              return false;
            }
            logger.ui.warn(
              `[TabEditor] Editor-mode toggle discarded ${content.length} unsaved bytes for ` +
                `${fileName} at the user's request: an AI edit is still pending review`,
            );
            return true;
          }
          const expected = lastSavedContentRef.current;
          const result = await window.electronAPI.saveFile(
            content,
            filePath,
            expected,
            'manual',
          );
          if (result?.conflict) {
            setAutosaveConflictDiskContent(typeof result.diskContent === 'string' ? result.diskContent : '');
            return false;
          }
          assertManualSaveSucceeded(result);
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

        // Reset editor ready state for the newly mounted editor.
        setIsEditorReady(false);
        setEditorInstance(null);
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
      onEditorContextItemsChanged: (items) => {
        setEditorContextItems(filePath, items);
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

  // Track on-screen visibility of this editor and fan out to host subscribers.
  useEffect(() => {
    const el = editorContainerRef.current;
    if (!el) return;
    const tracker = createElementVisibilityTracker(el);
    visibleRef.current = tracker.getVisible();
    const unsubscribe = tracker.subscribe((visible) => {
      visibleRef.current = visible;
      visibilityCallbacksRef.current.forEach((cb) => cb(visible));
    });
    return () => {
      unsubscribe();
      tracker.disconnect();
    };
  }, []);
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
          documentSessionActions={documentSessionActions}
          extensionMenuItems={extensionMenuItems}
          onToggleDebugTree={() => setShowTreeView(prev => !prev)}
          onContentChanged={() => setReloadVersion(v => v + 1)}
        />
        <FixedTabHeaderContainer
          filePath={filePath}
          fileName={fileName}
          editor={isMarkdown && !sourceMode ? editorRef.current : undefined}
        />
        {saveFailure !== null && (
          <div
            className="save-failure-banner flex items-center gap-2 px-3 py-2 text-[13px] bg-nim-warning-subtle border-b border-nim-warning text-nim"
            role="alert"
            data-testid="save-failure-banner"
          >
            <span className="flex-1">
              {getSaveFailureMessage(saveFailure.errorType, saveFailure.source)}
            </span>
            <button
              type="button"
              onClick={() => {
                void handleManualSave();
              }}
              className="px-2 py-1 rounded border border-nim text-nim hover:bg-nim-active"
              data-testid="save-failure-banner-retry"
            >
              Retry
            </button>
          </div>
        )}
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
              onClick={async () => {
                if (hasUnresolvedReview()) return;
                const handle = documentModelHandleRef.current;
                try {
                  const result = await window.electronAPI.readFileContent(filePath);
                  if (!handle || handle !== documentModelHandleRef.current || currentFilePathRef.current !== filePath) return;
                  if (!result?.success || typeof result.content !== 'string' || hasUnresolvedReview()) return;
                  const outcome = applyVerifiedReload(result.content);
                  commitReloadOutcome(outcome, result.content);
                  if (outcome.verified) {
                    documentModel?.setLastPersistedContent(result.content);
                    documentModelHandleRef.current?.setDirty(false);
                    setAutosaveConflictDiskContent(null);
                  }
                } catch (error) {
                  logger.ui.error('[TabEditor] Failed to reload disk content:', error);
                }
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
                      setEditorInstance(editorWrapper);
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
                        excludedProviderIds={excludedDocumentHeaderProviderIds}
                        trackerFieldCapabilities={trackerFieldCapabilities}
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
                        readOnlyWhileReviewing={customEditorReadOnlyDuringDiff}
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
                      excludedProviderIds={excludedDocumentHeaderProviderIds}
                      trackerFieldCapabilities={trackerFieldCapabilities}
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
                      readOnlyWhileReviewing={customEditorReadOnlyDuringDiff}
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
              {/* The Lexical header keys off diff nodes, of which a large-document
                  fallback has none -- without this bar the user would have a
                  pending review and no way to act on it (#4821, NIM-5359). */}
              {noInlineFallbackReview && (
                <UnifiedDiffHeader
                  filePath={filePath}
                  fileName={fileName}
                  capabilities={{
                    onAcceptAll: () => { void resolveNoInlineFallbackReview(true); },
                    onRejectAll: () => { void resolveNoInlineFallbackReview(false); },
                  }}
                  sessionInfo={diffSessionInfo || undefined}
                  onGoToSession={onOpenSessionInChat ? handleGoToSession : undefined}
                  editorType="lexical"
                />
              )}
              <div className="tab-editor-wrapper flex-1 overflow-hidden relative">
              <DocumentPathProvider documentPath={filePath}>
                <MarkdownEditor
                  key={`${filePath}-lexical`}
                  host={editorHost}
                  // This component already applies external file changes to the
                  // Lexical instance itself (see the handle.onFileChanged
                  // subscription above), together with the last-saved/dirty
                  // bookkeeping that has to move with them. Letting
                  // MarkdownEditor's own subscription run as well would re-parse
                  // the document a second time on every external change.
                  applyExternalFileChanges={false}
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
                        excludedProviderIds={excludedDocumentHeaderProviderIds}
                        trackerFieldCapabilities={trackerFieldCapabilities}
                      />
                    ),
                  }}
                  collaborationConfig={personalSyncConfig || undefined}
                  onEditorReady={(editor) => {
                    editorRef.current = editor;
                    setEditorInstance(editor);
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
                  setEditorInstance(editorWrapper);
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
                  excludedProviderIds={excludedDocumentHeaderProviderIds}
                  trackerFieldCapabilities={trackerFieldCapabilities}
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
                  setEditorInstance(editorWrapper);
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
