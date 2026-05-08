import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import type { LexicalCommand, TextReplacement } from '@nimbalyst/runtime';
import {
  APPROVE_DIFF_COMMAND,
  REJECT_DIFF_COMMAND,
  COPY_AS_MARKDOWN_COMMAND,
  parseFrontmatter,
  serializeWithFrontmatter,
  type FrontmatterData,
} from '@nimbalyst/runtime';
import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import { SearchReplaceStateManager } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { aiApi } from '../services/aiApi';
import { getFileName } from '../utils/pathUtils';
import { isCollabUri } from '../utils/collabUri';
import type { ContentMode } from '../types/WindowModeTypes';
import { dialogRef } from '../contexts/DialogContext';
import { DIALOG_IDS } from '../dialogs';
import {
  menuFindCommandAtom,
  menuFindNextCommandAtom,
  menuFindPreviousCommandAtom,
} from '../store/atoms/menuCommands';

// Tracker field updates now go through the generic trackerStatus frontmatter format.
// No hardcoded plan-specific field list needed.

function mergeFrontmatterData(
  existing: FrontmatterData | undefined,
  updates: Partial<FrontmatterData>,
): FrontmatterData {
  const result: FrontmatterData = existing ? { ...existing } : {};

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = value;
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const currentValue = result[key];
      const nestedExisting = (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue))
        ? (currentValue as FrontmatterData)
        : {};

      result[key] = mergeFrontmatterData(nestedExisting, value as Partial<FrontmatterData>);
      continue;
    }

    result[key] = value;
  }

  return result;
}

interface UseIPCHandlersProps {
  // Handlers passed in from parent
  handleNew: () => void;
  handleOpen: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
  handleWorkspaceFileSelect: (filePath: string) => Promise<void>;
  openWelcomeTab: () => Promise<void>;
  openFeedback: () => void;
  handleNextTab?: () => void;
  handlePreviousTab?: () => void;

  // State setters
  setIsApiKeyDialogOpen: (open: boolean) => void;
  setWorkspaceMode: (mode: boolean) => void;
  setWorkspacePath: (path: string | null) => void;
  setWorkspaceName: (name: string | null) => void;
  // NOTE: setFileTree removed - EditorMode manages file tree
  // NOTE: setCurrentFilePath/setCurrentFileName removed - now using refs to prevent re-renders
  // NOTE: setIsDirty removed - TabEditor owns dirty state and calls setDocumentEdited directly
  // NOTE: setIsNewFileDialogOpen removed - EditorMode manages dialogs
  setIsAIChatCollapsed: (collapsed: boolean) => void;
  setAIChatWidth: (width: number) => void;
  setIsAIChatStateLoaded: (loaded: boolean) => void;
  setSessionToLoad: (session: { sessionId: string; workspacePath?: string } | null) => void;
  // NOTE: setIsHistoryDialogOpen removed - EditorMode manages dialogs
  setIsKeyboardShortcutsDialogOpen: (open: boolean) => void;
  setTheme: (theme: any) => void;
  setAIPlanningMode?: (enabled: boolean) => void;

  // Refs
  // NOTE: initialContentRef removed - TabEditor tracks initialContent per-tab
  isInitializedRef: React.MutableRefObject<boolean>;
  // NOTE: isDirtyRef removed - TabEditor owns dirty state and calls setDocumentEdited directly
  // NOTE: contentVersionRef removed - EditorContainer doesn't need version bumping
  getContentRef: React.MutableRefObject<(() => string) | null>;
  searchCommandRef: React.MutableRefObject<LexicalCommand<undefined> | null>;
  editorModeRef: React.RefObject<any>; // EditorModeRef from EditorMode component
  currentFilePathRef: React.MutableRefObject<string | null>;
  currentFileNameRef: React.MutableRefObject<string | null>;

  // State values
  workspaceMode: boolean;
  workspacePath: string | null;
  sessionToLoad: { sessionId: string; workspacePath?: string } | null;
  activeMode: ContentMode;

  // Logging configuration
  LOG_CONFIG: {
    IPC_LISTENERS: boolean;
    WORKSPACE_OPS: boolean;
    FILE_OPS: boolean;
    FILE_WATCH: boolean;
    THEME: boolean;
  };
}

/**
 * Hook to set up all IPC handlers and listeners for communication with the main process.
 * This is a large effect that registers many event handlers for file operations, workspace management,
 * AI features, MCP server communication, and more.
 */
export function useIPCHandlers(props: UseIPCHandlersProps) {
  const {
    // Handlers
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleWorkspaceFileSelect,
    openWelcomeTab,
    openFeedback,
    handleNextTab,
    handlePreviousTab,

    // State setters
    setIsApiKeyDialogOpen,
    setWorkspaceMode,
    setWorkspacePath,
    setWorkspaceName,
    setIsAIChatCollapsed,
    setAIChatWidth,
    setIsAIChatStateLoaded,
    setSessionToLoad,
    setIsKeyboardShortcutsDialogOpen,
    setAIPlanningMode,
    setTheme,

    // Refs
    isInitializedRef,
    // NOTE: contentVersionRef removed - not needed for EditorContainer
    getContentRef,
    searchCommandRef,
    editorModeRef,
    currentFilePathRef,
    currentFileNameRef,

    // State values
    workspaceMode,
    workspacePath,
    sessionToLoad,
    activeMode,

    // Config
    LOG_CONFIG
  } = props;

  // Create a ref to hold current props for event handlers
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  }, [props]);

  // Create refs for all handlers and state to avoid re-registering IPC handlers
  const handlersRef = useRef({
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleWorkspaceFileSelect,
    openWelcomeTab,
    openFeedback,
    handleNextTab,
    handlePreviousTab,
    setIsApiKeyDialogOpen,
    setWorkspaceMode,
    setWorkspacePath,
    setWorkspaceName,
    // NOTE: setCurrentFilePath/setCurrentFileName removed - using refs directly
    // NOTE: setIsDirty removed - dirty state is tracked via isDirtyRef to avoid re-renders
    setIsAIChatCollapsed,
    setAIChatWidth,
    setIsAIChatStateLoaded,
    setSessionToLoad,
    setIsKeyboardShortcutsDialogOpen,
    setAIPlanningMode,
    setTheme,
  });

  const stateRef = useRef({
    workspaceMode,
    workspacePath,
    sessionToLoad,
    activeMode,
  });

  // Update refs whenever values change
  handlersRef.current = {
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleWorkspaceFileSelect,
    openWelcomeTab,
    openFeedback,
    handleNextTab,
    handlePreviousTab,
    setIsApiKeyDialogOpen,
    setWorkspaceMode,
    setWorkspacePath,
    setWorkspaceName,
    setIsAIChatCollapsed,
    setAIChatWidth,
    setIsAIChatStateLoaded,
    setSessionToLoad,
    setIsKeyboardShortcutsDialogOpen,
    setAIPlanningMode,
    setTheme,
  };

  stateRef.current = {
    workspaceMode,
    workspacePath,
    sessionToLoad,
    activeMode,
  };

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    // COMMENTED OUT - API key dialog no longer needed, using claude-code login
    // Check for first launch (no API key configured)
    // const checkFirstLaunch = async () => {
    //   try {
    //     const hasApiKey = await window.electronAPI.aiHasApiKey();
    //     if (!hasApiKey) {
    //       // Show API key dialog on first launch
    //       handlersRef.current.setIsApiKeyDialogOpen(true);
    //     }
    //   } catch (error) {
    //     console.error('Failed to check for API key:', error);
    //   }
    // };

    // Only check on initial mount (when currentFilePath is null)
    // if (!stateRef.current.currentFilePath && !stateRef.current.sessionToLoad) {
    //   checkFirstLaunch();
    // }

    // Set up listeners and store cleanup functions
    const cleanupFns: Array<() => void> = [];

    cleanupFns.push(window.electronAPI.onFileNew(handlersRef.current.handleNew));

    // Handle new file in workspace mode - EditorMode handles this via its own IPC listener
    // TODO: Remove this handler since EditorMode listens to file-new-in-workspace directly
    cleanupFns.push(window.electronAPI.onFileOpen(handlersRef.current.handleOpen));
    cleanupFns.push(window.electronAPI.onFileSave(handlersRef.current.handleSave));
    cleanupFns.push(window.electronAPI.onFileSaveAs(handlersRef.current.handleSaveAs));
    cleanupFns.push(window.electronAPI.onWorkspaceOpened(async (data) => {
      if (LOG_CONFIG.WORKSPACE_OPS) console.log('[WORKSPACE] Workspace opened:', data);
      handlersRef.current.setWorkspaceMode(true);
      handlersRef.current.setWorkspacePath(data.workspacePath);
      handlersRef.current.setWorkspaceName(data.workspaceName);
      // NOTE: setFileTree removed - EditorMode loads file tree from workspacePath
      // Clear current document refs (no re-render needed)
      currentFilePathRef.current = null;
      currentFileNameRef.current = null;
      // NOTE: isDirty is now managed by TabEditor
      // NOTE: contentVersion removed - EditorContainer handles remounting via destroy/create
      isInitializedRef.current = false;

      // Restore AI Chat state when opening a workspace
      try {
        const workspaceState = await window.electronAPI.invoke('workspace:get-state', data.workspacePath);
        const aiChatState = workspaceState?.aiPanel;
        // console.log('Restoring AI Chat state for workspace:', aiChatState);
        if (aiChatState) {
          handlersRef.current.setIsAIChatCollapsed(aiChatState.collapsed);
          handlersRef.current.setAIChatWidth(aiChatState.width);
          if (handlersRef.current.setAIPlanningMode) {
            handlersRef.current.setAIPlanningMode(aiChatState.planningModeEnabled ?? true);
          }
          if (aiChatState.currentSessionId) {
            handlersRef.current.setSessionToLoad({ sessionId: aiChatState.currentSessionId, workspacePath: data.workspacePath });
          }
        }
        handlersRef.current.setIsAIChatStateLoaded(true);
      } catch (error) {
        console.error('Failed to restore AI Chat state:', error);
        handlersRef.current.setIsAIChatStateLoaded(true);
      }

      // Open welcome tab if no tabs are open
      if (editorModeRef.current?.tabs && editorModeRef.current.tabs.tabs.length === 0) {
        // console.log('[WORKSPACE] No tabs open, opening welcome tab');
        // Delay slightly to ensure workspace state is fully set
        setTimeout(() => handlersRef.current.openWelcomeTab(), 100);
      }
    }));

    // Handle opening a specific file in a workspace (used when restoring workspace state)
    if (window.electronAPI.onOpenWorkspaceFile) {
      cleanupFns.push(window.electronAPI.onOpenWorkspaceFile(async (filePath) => {
        // console.log('Opening workspace file from saved state:', filePath);
        // Use the existing file selection handler
        await handlersRef.current.handleWorkspaceFileSelect(filePath);
      }));
    }

    if (window.electronAPI.onOpenDocument) {
      cleanupFns.push(window.electronAPI.onOpenDocument(async ({ path }) => {
        // console.log('[DOCUMENT_LINK] Renderer received open-document for path:', path);
        try {
          await handlersRef.current.handleWorkspaceFileSelect(path);
        } catch (error) {
          console.error('[DOCUMENT_LINK] Failed to open document reference:', error);
        }
      }));
    }

    // Handle workspace open from CLI
    if (window.electronAPI.onOpenWorkspaceFromCLI) {
      cleanupFns.push(window.electronAPI.onOpenWorkspaceFromCLI(async (workspacePath) => {
        // console.log('Opening workspace from CLI:', workspacePath);
        // Open the workspace using the existing openWorkspace API
        if (window.electronAPI.workspaceManager?.openWorkspace) {
          await window.electronAPI.workspaceManager.openWorkspace(workspacePath);
        }
      }));
    }

    // NOTE: onFileOpenedFromOS removed - all file opening now goes through open-document
    // which triggers handleWorkspaceFileSelect -> switchWorkspaceFile for content loading

    cleanupFns.push(window.electronAPI.onNewUntitledDocument((data) => {
      // console.log('Received new-untitled-document event:', data.untitledName);
      currentFilePathRef.current = null;
      currentFileNameRef.current = data.untitledName;
      // setIsDirty(true); // New documents start as dirty
      // NOTE: initialContentRef removed - TabEditor tracks this per-tab
      if (window.electronAPI) {
        window.electronAPI.setDocumentEdited(true);
      }
    }));
    // menu:find / menu:find-next / menu:find-previous are handled below via
    // counter atoms updated by store/listeners/menuCommandListeners.ts.

    // NOTE: file-deleted is now centrally tracked by store/listeners/fileChangeListeners.ts
    // and dispatched via fileDeletedAtomFamily(path). Each tab system that owns
    // a TabsProvider (EditorMode, WorkstreamEditorTabs, HiddenTabManager) is
    // responsible for subscribing to that atom and closing its own tabs. We
    // still need to clear the single-file fallback path here, in case the
    // current document is deleted and there's no tabs context.
    cleanupFns.push(window.electronAPI.onFileDeleted((data) => {
      if (!editorModeRef.current?.tabs && currentFilePathRef.current === data.filePath) {
        currentFilePathRef.current = null;
      }
    }));

    // NOTE: File watching is now handled by TabEditor component for each individual tab.
    // The legacy file change handler has been removed as it's no longer needed.
    cleanupFns.push(window.electronAPI.onFileMoved(async (data) => {
      // console.log('File moved:', data);

      // Update the tab for this file
      if (editorModeRef.current?.tabs) {
        const tab = editorModeRef.current.tabs.findTabByPath(data.sourcePath);
        if (tab) {
          const newFileName = getFileName(data.destinationPath);
          editorModeRef.current.tabs.updateTab(tab.id, {
            filePath: data.destinationPath,
            fileName: newFileName
          });
        }
      }

      // Update current file path if it was moved (legacy single-file mode)
      if (currentFilePathRef.current === data.sourcePath) {
        currentFilePathRef.current = data.destinationPath;
        currentFileNameRef.current = getFileName(data.destinationPath);
      }
    }));
    cleanupFns.push(window.electronAPI.onThemeChange((newTheme) => {
      const editorTheme = newTheme === 'system' ? 'auto' : newTheme;

      // Apply theme immediately - theme changes are purely visual and don't affect content
      if (handlersRef.current.setTheme) {
        handlersRef.current.setTheme(editorTheme);
      }

      // NOTE: We do NOT reload from disk on theme change. Theme is purely CSS.
      // The TabEditor component manages its own content state and will preserve it across theme changes.
    }));

    // Listen for show preferences event
    cleanupFns.push(window.electronAPI.onFileRenamed((data) => {
      // console.log('File renamed:', data);

      // Update the tab for this file
      if (editorModeRef.current?.tabs) {
        const tab = editorModeRef.current.tabs.findTabByPath(data.oldPath);
        if (tab) {
          const newFileName = getFileName(data.newPath);
          editorModeRef.current.tabs.updateTab(tab.id, {
            filePath: data.newPath,
            fileName: newFileName
          });
        }
      }

      // Update current file path if it was renamed (legacy single-file mode)
      if (currentFilePathRef.current === data.oldPath) {
        currentFilePathRef.current = data.newPath;
        currentFileNameRef.current = getFileName(data.newPath);
      }
    }));
    // NOTE: File tree updates handled by EditorMode directly via onWorkspaceFileTreeUpdated

    // Load session from Session Manager
    if (window.electronAPI.onLoadSessionFromManager) {
      cleanupFns.push(window.electronAPI.onLoadSessionFromManager(async (data: { sessionId: string; workspacePath?: string }) => {
        // console.log('Loading session from manager:', data);

        // If there's a workspace path and we're not in workspace mode, open the workspace first
        if (data.workspacePath && !stateRef.current.workspaceMode) {
          // Open the workspace
          const workspaceName = getFileName(data.workspacePath) || 'Workspace';
          const fileTree = await window.electronAPI.getFolderContents(data.workspacePath);
          handlersRef.current.setWorkspaceMode(true);
          handlersRef.current.setWorkspacePath(data.workspacePath);
          handlersRef.current.setWorkspaceName(workspaceName);
          // NOTE: setFileTree removed - EditorMode loads file tree from workspacePath
        }

        // Set the session to load - AIChat will pick this up
        handlersRef.current.setSessionToLoad(data);

        // Make sure AI Chat is visible
        handlersRef.current.setIsAIChatCollapsed(false);
      }));
    }

    // NOTE: view-history IPC event (Cmd+Y) is handled in App.tsx which gates it by active mode

    // Tab navigation handlers - delegate to App.tsx for mode-aware routing
    if (window.electronAPI.onNextTab && handlersRef.current.handleNextTab) {
      cleanupFns.push(window.electronAPI.onNextTab(() => {
        handlersRef.current.handleNextTab?.();
      }));
    }

    if (window.electronAPI.onPreviousTab && handlersRef.current.handlePreviousTab) {
      cleanupFns.push(window.electronAPI.onPreviousTab(() => {
        handlersRef.current.handlePreviousTab?.();
      }));
    }

    // Approve/Reject action handlers
    if (window.electronAPI.onApproveAction) {
      cleanupFns.push(window.electronAPI.onApproveAction(() => {
        // console.log('Approve action triggered');
        // Get the active editor from the registry
        const activeFilePath = editorRegistry.getActiveFilePath();
        if (activeFilePath) {
          const editorInstance = editorRegistry.getEditor(activeFilePath);
          if (editorInstance && editorInstance.editor) {
            editorInstance.editor.dispatchCommand(APPROVE_DIFF_COMMAND, undefined);
          }
        }
      }));
    }

    if (window.electronAPI.onRejectAction) {
      cleanupFns.push(window.electronAPI.onRejectAction(() => {
        // console.log('Reject action triggered');
        // Get the active editor from the registry
        const activeFilePath = editorRegistry.getActiveFilePath();
        if (activeFilePath) {
          const editorInstance = editorRegistry.getEditor(activeFilePath);
          if (editorInstance && editorInstance.editor) {
            editorInstance.editor.dispatchCommand(REJECT_DIFF_COMMAND, undefined);
          }
        }
      }));
    }

    // Copy as Markdown handler
    if (window.electronAPI.onCopyAsMarkdown) {
      cleanupFns.push(window.electronAPI.onCopyAsMarkdown(() => {
        // console.log('Copy as Markdown triggered from menu');
        // Get the active editor from the registry
        const activeFilePath = editorRegistry.getActiveFilePath();
        if (activeFilePath) {
          const editorInstance = editorRegistry.getEditor(activeFilePath);
          if (editorInstance && editorInstance.editor) {
            // Create a synthetic keyboard event to pass to the command
            const syntheticEvent = new KeyboardEvent('keydown', {
              code: 'KeyC',
              shiftKey: true,
              metaKey: true,
              bubbles: true,
              cancelable: true
            });
            editorInstance.editor.dispatchCommand(COPY_AS_MARKDOWN_COMMAND, syntheticEvent);
          }
        }
      }));
    }

    // MCP Server handlers
    if (window.electronAPI.onMcpApplyDiff) {
      cleanupFns.push(window.electronAPI.onMcpApplyDiff(async ({ replacements, resultChannel, targetFilePath }) => {
        try {
          // SAFETY: Require explicit targetFilePath - no fallbacks allowed
          if (!targetFilePath) {
            console.error('[MCP] applyDiff requires explicit targetFilePath - no target file specified');
            if (window.electronAPI.sendMcpApplyDiffResult) {
              window.electronAPI.sendMcpApplyDiffResult(resultChannel, {
                success: false,
                error: 'applyDiff requires explicit targetFilePath parameter'
              });
            }
            return;
          }

          const filePath = targetFilePath;

          // Validate target: filesystem markdown files OR shared collab docs.
          const isCollab = isCollabUri(filePath);
          if (!isCollab && !filePath.endsWith('.md')) {
            console.error('[MCP] applyDiff can only modify markdown files or collab docs:', filePath);
            if (window.electronAPI.sendMcpApplyDiffResult) {
              window.electronAPI.sendMcpApplyDiffResult(resultChannel, {
                success: false,
                error: `applyDiff can only modify markdown files (.md) or collaborative documents (collab:// URIs). Attempted to modify: ${filePath}`
              });
            }
            return;
          }

          // If the file isn't registered (not open), open it in the background.
          // Collaborative docs cannot be opened in the background here — they
          // require an active CollaborativeTabEditor backed by a Y.Doc.
          if (!editorRegistry.has(filePath)) {
            if (isCollab) {
              if (window.electronAPI.sendMcpApplyDiffResult) {
                window.electronAPI.sendMcpApplyDiffResult(resultChannel, {
                  success: false,
                  error: `Cannot edit collab document ${filePath}: no editor is currently mounted for it. Open the document in collab mode first.`
                });
              }
              return;
            }
            // Read the file content
            const result = await window.electronAPI.readFileContent(filePath);
            const fileContent = result?.success ? result.content : '';

            // Open the file using editorRegistry's file opener
            await editorRegistry.openFileInBackground(filePath, fileContent);
          }

          // Use the editor registry to apply replacements to the target file
          // Pass the resultChannel as a unique ID so the event can be correlated
          const result = await editorRegistry.applyReplacements(filePath, replacements, resultChannel);

          // Ensure result is defined and has the expected shape
          const finalResult = result || { success: false, error: 'No result returned from diff application' };

          if (window.electronAPI.sendMcpApplyDiffResult) {
            // Make sure we have all required properties and no undefined values
            const resultToSend = {
              success: finalResult.success ?? false
            };
            // Only add error if it exists (IPC can't handle undefined values)
            if (finalResult.error) {
              (resultToSend as any).error = finalResult.error;
            }
            window.electronAPI.sendMcpApplyDiffResult(resultChannel, resultToSend);
          }

          // Show error in UI if the diff failed
          if (!finalResult.success) {
            console.error('Diff application failed:', finalResult.error);
            // You could also show a toast or notification here
            // For now, we'll just make sure it's visible in the console
          }
        } catch (error) {
          console.error('MCP applyDiff error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (window.electronAPI.sendMcpApplyDiffResult) {
            // Ensure we're sending a clean object without undefined values
            window.electronAPI.sendMcpApplyDiffResult(resultChannel, {
              success: false,
              error: errorMessage || 'Unknown error'
            });
          }

          // Could show error notification here
          // alert(`Failed to apply edit: ${errorMessage}`);
        }
      }));
    }

    if (window.electronAPI.onMcpReadCollabDoc) {
      cleanupFns.push(window.electronAPI.onMcpReadCollabDoc(async ({ targetFilePath, resultChannel }) => {
        try {
          if (!targetFilePath || !isCollabUri(targetFilePath)) {
            window.electronAPI.sendMcpReadCollabDocResult(resultChannel, {
              success: false,
              error: `readCollabDoc requires a collab:// URI. Got: ${targetFilePath ?? '(missing)'}`,
            });
            return;
          }

          if (!editorRegistry.has(targetFilePath)) {
            window.electronAPI.sendMcpReadCollabDocResult(resultChannel, {
              success: false,
              error: `No editor mounted for ${targetFilePath}. Open the document in collab mode first.`,
            });
            return;
          }

          const content = editorRegistry.getContent(targetFilePath);
          window.electronAPI.sendMcpReadCollabDocResult(resultChannel, {
            success: true,
            content,
          });
        } catch (error) {
          window.electronAPI.sendMcpReadCollabDocResult(resultChannel, {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error reading collab doc',
          });
        }
      }));
    }

    if (window.electronAPI.onMcpStreamContent) {
      // console.log('[MCP] Registering onMcpStreamContent handler');
      cleanupFns.push(window.electronAPI.onMcpStreamContent(async ({ streamId, content, position, insertAfter, mode, targetFilePath, resultChannel }) => {
        // console.log('[MCP] ==========================================');
        // console.log('[MCP] streamContent IPC RECEIVED');
        // console.log('[MCP] streamId:', streamId);
        // console.log('[MCP] position:', position);
        // console.log('[MCP] mode:', mode);
        // console.log('[MCP] targetFilePath:', targetFilePath);
        // console.log('[MCP] content preview:', content?.substring(0, 100));
        // console.log('[MCP] resultChannel:', resultChannel);
        // console.log('[MCP] ==========================================');

        try {
          // Use the explicit targetFilePath from the IPC message, or fall back to first registered editor
          const filePath = targetFilePath || editorRegistry.getFilePaths()[0];

          if (!filePath) {
            console.error('[MCP] ERROR: No target file path available for streamContent');
            console.error('[MCP] Registered file paths:', editorRegistry.getFilePaths());
            if (window.electronAPI.sendMcpStreamContentResult) {
              window.electronAPI.sendMcpStreamContentResult(resultChannel, {
                success: false,
                error: 'No target file path available'
              });
            }
            return;
          }

          // console.log('[MCP] Using filePath:', filePath);
          // console.log('[MCP] Registered editors:', editorRegistry.getFilePaths());

          // Start streaming
          // console.log('[MCP] Calling startStreaming...');
          editorRegistry.startStreaming(filePath, {
            id: streamId,
            position: position || 'cursor',
            mode: mode || 'append', // Default to 'append' mode for streaming
            insertAfter,
            // Handle both 'end' (from schema) and 'end of document' (AI sometimes ignores enum)
            insertAtEnd: position === 'end' || position === 'end of document'
          });

          // Small delay to let the streaming processor register
          await new Promise(resolve => setTimeout(resolve, 50));

          // Stream the content
          // console.log('[MCP] Calling streamContent...');
          editorRegistry.streamContent(filePath, streamId, content);

          // End streaming
          // console.log('[MCP] Calling endStreaming...');
          editorRegistry.endStreaming(filePath, streamId);

          // console.log('[MCP] Streaming complete, sending success result');

          // Send success result
          if (window.electronAPI.sendMcpStreamContentResult) {
            window.electronAPI.sendMcpStreamContentResult(resultChannel, {
              success: true
            });
          }

          // console.log('[MCP] Success result sent');
        } catch (error) {
          console.error('[MCP] streamContent error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (window.electronAPI.sendMcpStreamContentResult) {
            window.electronAPI.sendMcpStreamContentResult(resultChannel, {
              success: false,
              error: errorMessage
            });
          }
        }
      }));
    }

    if (window.electronAPI.onMcpNavigateTo) {
      cleanupFns.push(window.electronAPI.onMcpNavigateTo(({ line, column }) => {
        // console.log('MCP navigateTo request:', { line, column });
        // TODO: Implement navigation to specific line/column in editor
        // This would require adding a navigation command to the editor
      }));
    }

    // Git commit proposal - widget renders directly from tool call data
    // No IPC listener or atom sync needed
    // See packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/GitCommitConfirmationWidget.tsx

    // AI Tool handlers for document manipulation
    // Note: onAIApplyDiff is handled by aiApi.ts to avoid duplicate applications

    if (window.electronAPI.onAIGetDocumentContent) {
      cleanupFns.push(window.electronAPI.onAIGetDocumentContent(async ({ filePath, resultChannel }) => {
        // console.log('AI getDocumentContent request for:', filePath);
        try {
          // SAFETY: Require explicit filePath
          if (!filePath) {
            throw new Error('getDocumentContent requires filePath parameter');
          }

          // Get content from the editor registry for the specified file
          const content = editorRegistry.getContent(filePath);

          if (window.electronAPI.sendAIGetDocumentContentResult) {
            window.electronAPI.sendAIGetDocumentContentResult(resultChannel, {
              content: content || ''
            });
          }
        } catch (error) {
          console.error('AI getDocumentContent error:', error);

          if (window.electronAPI.sendAIGetDocumentContentResult) {
            window.electronAPI.sendAIGetDocumentContentResult(resultChannel, {
              content: ''
            });
          }
        }
      }));
    }

    if (window.electronAPI.onAIUpdateFrontmatter) {
      cleanupFns.push(window.electronAPI.onAIUpdateFrontmatter(async ({ filePath, updates, resultChannel }) => {
        // console.log('AI updateFrontmatter request for:', filePath, 'updates:', updates);
        try {
          // SAFETY: Require explicit filePath
          if (!filePath) {
            throw new Error('updateFrontmatter requires filePath parameter');
          }

          const currentContent = editorRegistry.getContent(filePath);
          const { data: existingData } = parseFrontmatter(currentContent);

          // All tracker updates go to top-level frontmatter fields (trackerStatus holds only type).
          // The generic model treats all fields equally -- no special routing for plan/decision fields.
          const normalizedUpdates: Record<string, unknown> = { ...updates };
          const mergedData = mergeFrontmatterData(existingData ?? {}, normalizedUpdates as Partial<FrontmatterData>);

          // `\r?\n` tolerates Windows CRLF (nimbalyst#68).
          const frontmatterMatch = currentContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
          const newFrontmatterBlockBase = serializeWithFrontmatter('', mergedData);

          let replacements: Array<{ oldText: string; newText: string }>;

          if (frontmatterMatch) {
            const originalFrontmatterBlock = frontmatterMatch[0];
            const trailingNewlines = originalFrontmatterBlock.match(/\n*$/)?.[0] ?? '';
            const trimmedBase = newFrontmatterBlockBase.replace(/\s*$/, '');
            const newFrontmatterBlock = `${trimmedBase}${trailingNewlines || '\n'}`;

            replacements = [{
              oldText: originalFrontmatterBlock,
              newText: newFrontmatterBlock,
            }];
          } else {
            const trimmedBase = newFrontmatterBlockBase.replace(/\s*$/, '');
            const newFrontmatterBlock = `${trimmedBase}\n\n`;
            replacements = [{
              oldText: currentContent,
              newText: `${newFrontmatterBlock}${currentContent}`,
            }];
          }

          // Apply the replacement
          const result = await editorRegistry.applyReplacements(filePath, replacements);
          const finalResult = result || { success: false, error: 'Failed to update frontmatter' };

          if (window.electronAPI.sendAIUpdateFrontmatterResult) {
            const resultToSend = {
              success: finalResult.success ?? false
            };
            if (finalResult.error) {
              (resultToSend as any).error = finalResult.error;
            }
            window.electronAPI.sendAIUpdateFrontmatterResult(resultChannel, resultToSend);
          }
        } catch (error) {
          console.error('AI updateFrontmatter error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (window.electronAPI.sendAIUpdateFrontmatterResult) {
            window.electronAPI.sendAIUpdateFrontmatterResult(resultChannel, {
              success: false,
              error: errorMessage || 'Unknown error'
            });
          }
        }
      }));
    }

    // Handle AI create document requests from main process
    if (window.electronAPI.onAICreateDocument) {
      cleanupFns.push(window.electronAPI.onAICreateDocument(async ({ filePath, initialContent, switchToFile, resultChannel }) => {
        // console.log('AI createDocument request from main:', { filePath, switchToFile });
        try {
          // Create the document via IPC
          const result = await window.electronAPI.invoke('create-document', filePath, initialContent);

          if (result.success) {
            // Switch to the new file if requested
            if (switchToFile && result.filePath) {
              // console.log('Switching to new file:', result.filePath);
              await handlersRef.current.handleWorkspaceFileSelect(result.filePath);
            }

            // Send success response back to main process
            if (window.electronAPI.sendAICreateDocumentResult) {
              window.electronAPI.sendAICreateDocumentResult(resultChannel, {
                success: true,
                filePath: result.filePath
              });
            } else {
              // Fallback to generic IPC send
              window.electronAPI.send(resultChannel, {
                success: true,
                filePath: result.filePath
              });
            }
          } else {
            throw new Error(result.error || 'Failed to create document');
          }
        } catch (error) {
          console.error('AI createDocument error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (window.electronAPI.sendAICreateDocumentResult) {
            window.electronAPI.sendAICreateDocumentResult(resultChannel, {
              success: false,
              error: errorMessage
            });
          } else {
            // Fallback to generic IPC send
            window.electronAPI.send(resultChannel, {
              success: false,
              error: errorMessage
            });
          }
        }
      }));
    }

    // Handle open welcome tab from menu
    if (window.electronAPI.onOpenWelcomeTab) {
      cleanupFns.push(window.electronAPI.onOpenWelcomeTab(() => {
        // console.log('Open welcome tab command received from menu');
        handlersRef.current.openWelcomeTab();
      }));
    }

    // Handle open keyboard shortcuts dialog from menu
    if ((window.electronAPI as any).onOpenKeyboardShortcuts) {
      cleanupFns.push((window.electronAPI as any).onOpenKeyboardShortcuts(() => {
        // console.log('Open keyboard shortcuts dialog command received from menu');
        if (dialogRef.current) {
          dialogRef.current.open(DIALOG_IDS.KEYBOARD_SHORTCUTS, {});
        }
      }));
    }

    // Handle open feedback dialog from menu
    if ((window.electronAPI as any).onOpenFeedback) {
      cleanupFns.push((window.electronAPI as any).onOpenFeedback(() => {
        // console.log('Open feedback dialog command received from menu');
        handlersRef.current.openFeedback();
      }));
    }

    // Handle open plans tab from menu
    if ((window.electronAPI as any).onOpenPlansTab) {
      // Open plans tab handler removed - use bottom panel instead
    }

    // Update MCP document state whenever content or selection changes
    const updateDocumentState = () => {
      if (window.electronAPI?.updateMcpDocumentState && getContentRef.current) {
        const content = getContentRef.current();
        const docState = {
          content,
          filePath: currentFilePathRef.current || 'untitled.md',
          fileType: 'markdown',
          workspacePath: stateRef.current.workspacePath, // Use workspace path for window routing
          // TODO: Get actual cursor position and selection from editor
          cursorPosition: undefined,
          selection: undefined
        };

        // DEFENSIVE: Log what we're sending
        // console.log('[Renderer] Sending MCP document state:', {
        //   filePath: docState.filePath,
        //   workspacePath: docState.workspacePath,
        //   hasWorkspacePath: !!docState.workspacePath,
        //   workspaceMode: stateRef.current.workspaceMode
        // });

        window.electronAPI.updateMcpDocumentState(docState);
      }
    };

    // Update document state when file is opened
    if (currentFilePathRef.current) {
      updateDocumentState();
    }

    // Set up AI streaming event listeners
    // These connect the aiApi events to the editorRegistry methods
    // Track the current stream's target file path to prevent race conditions
    // when user switches tabs during streaming
    let currentStreamTargetFilePath: string | null = null;

    const handleStreamEditStart = (data: any) => {
      // console.log('[AI Streaming] Stream edit started:', { sessionId: data.sessionId, config: data });

      // Use explicit targetFilePath from data - this was captured when the message was sent
      // and prevents race conditions if user switches tabs while waiting for AI
      const filePath = data.targetFilePath;

      if (!filePath) {
        console.error('[AI Streaming] CRITICAL: No targetFilePath provided in stream start - this is a bug. Cannot safely apply streaming edit.');
        return;
      }

      // Store the target for subsequent content/end events
      currentStreamTargetFilePath = filePath;

      editorRegistry.startStreaming(filePath, {
        id: data.id || 'ai-stream',
        position: data.position || 'end',
        mode: data.mode,
        insertAfter: data.insertAfter,
        insertAtEnd: data.insertAtEnd ?? true
      });
    };

    const handleStreamEditContent = (data: any) => {
      // Handle both old format (string) and new format ({ sessionId, content })
      const content = typeof data === 'string' ? data : data.content;
      const sessionId = typeof data === 'object' ? data.sessionId : undefined;
      // console.log('[AI Streaming] Stream edit content:', { sessionId, preview: content?.substring(0, 50) });

      // Use the target file path captured at stream start
      const filePath = currentStreamTargetFilePath;
      if (!filePath) {
        console.error('[AI Streaming] No target file path - stream may not have started properly');
        return;
      }

      editorRegistry.streamContent(filePath, 'ai-stream', content);
    };

    const handleStreamEditEnd = (data: any) => {
      // console.log('[AI Streaming] Stream edit ended:', { sessionId: data?.sessionId, error: data?.error });

      // Use the target file path captured at stream start
      const filePath = currentStreamTargetFilePath;
      if (!filePath) {
        console.error('[AI Streaming] No target file path - stream may not have started properly');
        return;
      }

      editorRegistry.endStreaming(filePath, 'ai-stream');

      // Clear the target after stream ends
      currentStreamTargetFilePath = null;
    };

    aiApi.on('streamEditStart', handleStreamEditStart);
    aiApi.on('streamEditContent', handleStreamEditContent);
    aiApi.on('streamEditEnd', handleStreamEditEnd);

    // play-completion-sound and play-permission-sound are handled by the
    // central listener in store/listeners/soundListeners.ts.

    // Clean up listeners when dependencies change
    return () => {
      // console.log('Cleaning up IPC listeners');
      cleanupFns.forEach(cleanup => cleanup());

      // Clean up AI streaming listeners
      aiApi.off('streamEditStart', handleStreamEditStart);
      aiApi.off('streamEditContent', handleStreamEditContent);
      aiApi.off('streamEditEnd', handleStreamEditEnd);
    };
  }, []); // Empty dependency array - handlers use refs to access current values

  // React to menu:find / find-next / find-previous commands. The IPC
  // subscriptions live in store/listeners/menuCommandListeners.ts.
  const menuFindVersion = useAtomValue(menuFindCommandAtom);
  const menuFindNextVersion = useAtomValue(menuFindNextCommandAtom);
  const menuFindPreviousVersion = useAtomValue(menuFindPreviousCommandAtom);
  const menuFindInitialRef = useRef(menuFindVersion);
  const menuFindNextInitialRef = useRef(menuFindNextVersion);
  const menuFindPreviousInitialRef = useRef(menuFindPreviousVersion);

  useEffect(() => {
    if (menuFindVersion === menuFindInitialRef.current) return;
    const mode = propsRef.current.activeMode;
    if (mode === 'files') {
      const activeFilePath = editorRegistry.getActiveFilePath();
      if (activeFilePath) {
        SearchReplaceStateManager.toggle(activeFilePath);
      }
    } else if (mode === 'agent') {
      window.dispatchEvent(new CustomEvent('menu:find'));
    }
  }, [menuFindVersion]);

  useEffect(() => {
    if (menuFindNextVersion === menuFindNextInitialRef.current) return;
    if (propsRef.current.activeMode === 'agent') {
      window.dispatchEvent(new CustomEvent('menu:find-next'));
    }
    // Editor mode: Monaco/Lexical handle this via their own keyboard shortcuts.
  }, [menuFindNextVersion]);

  useEffect(() => {
    if (menuFindPreviousVersion === menuFindPreviousInitialRef.current) return;
    if (propsRef.current.activeMode === 'agent') {
      window.dispatchEvent(new CustomEvent('menu:find-previous'));
    }
  }, [menuFindPreviousVersion]);
}
