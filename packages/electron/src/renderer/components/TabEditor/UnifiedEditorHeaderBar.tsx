/**
 * UnifiedEditorHeaderBar - Consistent header bar for all editor types
 *
 * Renders above all editor content (Markdown, Monaco, CSV, custom editors).
 * Features:
 * - Breadcrumb path navigation
 * - AI Sessions button (for files edited by AI)
 * - TOC button (for Markdown files only)
 * - Actions menu (View History, Toggle Source Mode, Set Document Type, etc.)
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { $isHeadingNode } from '@lexical/rich-text';
import { $getRoot } from 'lexical';
import {
  $convertToEnhancedMarkdownString,
  $convertFromEnhancedMarkdownString,
  getEditorTransformers,
  wrapWithPrintStyles,
  applyTrackerTypeToMarkdown,
  getDefaultFrontmatterForType,
  getModelDefaults,
  getCurrentTrackerTypeFromMarkdown,
  removeTrackerTypeFromMarkdown,
  type TrackerTypeInfo,
} from '@nimbalyst/runtime';
import { $generateHtmlFromNodes } from '@lexical/html';
import { copyToClipboard, ProviderIcon } from '@nimbalyst/runtime';
import { historyDialogFileAtom } from '../../store';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';
import { getDocumentService } from '../../services/RendererDocumentService';
import { isWorktreePath } from '../../../shared/pathUtils';
import { CommonFileActions } from '../CommonFileActions';
import { FilePathBreadcrumb } from '../common/FilePathBreadcrumb';
import { dialogRef, DIALOG_IDS } from '../../dialogs';
import type { ShareDialogData } from '../../dialogs';
import { useLocalFileSharedDocLink } from '../../hooks/useCollabLocalOrigin';
import { sharedDocumentsAtom, pendingCollabDocumentAtom, activeTeamOrgIdAtom, buildSharedDocumentDeepLink } from '../../store/atoms/collabDocuments';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { getCollabNodeName, getCollabParentPath, normalizeCollabPath } from '../CollabMode/collabTree';

// Built-in tracker types that support full-document mode
const TRACKER_TYPES: TrackerTypeInfo[] = [
  { type: 'plan', displayName: 'Plan', icon: 'flag', color: '#3b82f6' },
  { type: 'decision', displayName: 'Decision', icon: 'gavel', color: '#8b5cf6' },
];

// Editor reference type - can be LexicalEditor or any editor with similar interface
interface EditorLike {
  getEditorState: () => { read: (fn: () => void) => void };
  registerUpdateListener: (callback: () => void) => () => void;
  getElementByKey: (key: string) => HTMLElement | null;
  update: (fn: () => void) => void;
}

interface AISession {
  id: string;
  title: string;
  provider: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  worktreeId?: string | null;
  isCurrentWorkspace?: boolean;
}

const SessionItem: React.FC<{
  session: AISession;
  isLast?: boolean;
  onClick?: (id: string) => void;
  onOpenChat?: (id: string) => void;
  formatTime: (ts: number) => string;
}> = ({ session, isLast, onClick, onOpenChat, formatTime }) => (
  <div
    className={`ai-session-item py-2 px-3 flex items-center gap-2 ${isLast ? 'last:border-b-0' : ''} hover:bg-[var(--nim-bg-hover)] cursor-pointer`}
    onClick={() => onClick?.(session.id)}
  >
    <span className="shrink-0 text-[var(--nim-text-muted)]"><ProviderIcon provider={session.provider} size={14} /></span>
    <div className="ai-session-title text-sm font-medium whitespace-nowrap overflow-hidden text-ellipsis text-[var(--nim-text)] flex-1 min-w-0">{session.title}</div>
    <div className="ai-session-time text-xs text-[var(--nim-text-faint)] shrink-0">{formatTime(session.updatedAt)}</div>
    {onOpenChat && (
      <button
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)] transition-colors duration-150 bg-transparent border-none cursor-pointer"
        title="Open in Chat panel"
        onClick={(e) => { e.stopPropagation(); onOpenChat(session.id); }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
    )}
  </div>
);

interface TOCItem {
  text: string;
  level: number;
  key: string;
}

interface ExtensionMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
}

interface UnifiedEditorHeaderBarProps {
  filePath: string;
  fileName: string;
  workspaceId?: string;
  breadcrumbContent?: React.ReactNode;

  // Editor type info
  isMarkdown?: boolean;
  isCustomEditor?: boolean;
  extensionId?: string;

  // Lexical editor reference (for TOC extraction and markdown operations)
  lexicalEditor?: EditorLike;

  // Action callbacks
  onToggleSourceMode?: () => void;
  supportsSourceMode?: boolean;
  isSourceModeActive?: boolean;

  // Markdown-specific callbacks
  onToggleMarkdownMode?: () => void;  // Switch to Monaco for raw editing
  onDirtyChange?: (isDirty: boolean) => void;  // Mark document as dirty after changes

  // AI session callbacks
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;

  // Extension menu items (contributed by custom editors)
  extensionMenuItems?: ExtensionMenuItem[];
  extraActionItems?: ExtensionMenuItem[];
  onOpenExtensionSettings?: () => void;

  // Debug tree toggle (dev mode only)
  onToggleDebugTree?: () => void;

  // Signal that content changed (e.g., frontmatter injected), so document headers re-check
  onContentChanged?: () => void;

  // Visibility overrides for non-local editor shells
  showAIButton?: boolean;
  showShareLinkButton?: boolean;
  showSharedDocButton?: boolean;
  showHistoryAction?: boolean;
  showCommonFileActions?: boolean;
}

export const UnifiedEditorHeaderBar: React.FC<UnifiedEditorHeaderBarProps> = ({
  filePath,
  fileName,
  workspaceId,
  breadcrumbContent,
  isMarkdown = false,
  isCustomEditor = false,
  extensionId,
  lexicalEditor,
  onToggleSourceMode,
  supportsSourceMode = false,
  isSourceModeActive = false,
  onToggleMarkdownMode,
  onDirtyChange,
  onSwitchToAgentMode,
  onOpenSessionInChat,
  extensionMenuItems = [],
  extraActionItems = [],
  onOpenExtensionSettings,
  onToggleDebugTree,
  onContentChanged,
  showAIButton,
  showShareLinkButton = isMarkdown,
  showSharedDocButton = true,
  showHistoryAction = true,
  showCommonFileActions = true,
}) => {
  const openHistoryDialog = useSetAtom(historyDialogFileAtom);

  // Dropdown states
  const [showAISessions, setShowAISessions] = useState(false);
  const [showTOC, setShowTOC] = useState(false);
  const [showDocTypeSubmenu, setShowDocTypeSubmenu] = useState(false);

  // Actions menu - uses floating-ui for portal rendering + viewport overflow protection
  const actionsMenu = useFloatingMenu({ placement: 'bottom-end' });
  const showActionsMenu = actionsMenu.isOpen;
  const setShowActionsMenu = actionsMenu.setIsOpen;
  const sharedDocMenu = useFloatingMenu({ placement: 'bottom-end' });
  const sharedDocLink = useLocalFileSharedDocLink(workspaceId ?? '', filePath);
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const teamOrgId = useAtomValue(activeTeamOrgIdAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const setPendingCollabDoc = useSetAtom(pendingCollabDocumentAtom);

  // Look up the shared document by id so we can show its name + folder
  const sharedDocument = useMemo(() => {
    const id = sharedDocLink.binding?.documentId;
    if (!id) return null;
    return sharedDocuments.find((doc) => doc.documentId === id) ?? null;
  }, [sharedDocLink.binding?.documentId, sharedDocuments]);

  const sharedDocNameAndFolder = useMemo(() => {
    if (sharedDocument?.title) {
      const normalized = normalizeCollabPath(sharedDocument.title);
      return {
        name: getCollabNodeName(normalized) || sharedDocument.title,
        folder: getCollabParentPath(normalized),
      };
    }
    // Fall back to the local source basename if the shared-docs index hasn't loaded yet
    if (sharedDocLink.binding?.sourceBasename) {
      return { name: sharedDocLink.binding.sourceBasename, folder: null };
    }
    return null;
  }, [sharedDocument, sharedDocLink.binding?.sourceBasename]);

  const handleOpenSharedDoc = useCallback(() => {
    const documentId = sharedDocLink.binding?.documentId;
    if (!documentId) return;
    setWindowMode('collab');
    setPendingCollabDoc({
      documentId,
      documentType: sharedDocument?.documentType ?? sharedDocLink.binding?.documentType,
    });
    sharedDocMenu.setIsOpen(false);
  }, [
    sharedDocLink.binding?.documentId,
    sharedDocLink.binding?.documentType,
    sharedDocument?.documentType,
    setWindowMode,
    setPendingCollabDoc,
    sharedDocMenu,
  ]);

  // Copy a deep link to the linked shared document (only meaningful for shared docs)
  const sharedDocDeepLinkAvailable = Boolean(sharedDocLink.binding?.documentId && teamOrgId);
  const handleCopyDeepLink = useCallback(async () => {
    const documentId = sharedDocLink.binding?.documentId;
    if (!documentId || !teamOrgId) return;
    const url = buildSharedDocumentDeepLink(documentId, teamOrgId);
    try {
      await copyToClipboard(url);
      console.log('[UnifiedHeaderBar] Shared document link copied to clipboard');
    } catch (err) {
      console.error('[UnifiedHeaderBar] Failed to copy shared document link:', err);
    }
    setShowActionsMenu(false);
  }, [sharedDocLink.binding?.documentId, teamOrgId, setShowActionsMenu]);

  // Dev mode check
  const isDevMode = import.meta.env.DEV;

  // AI Sessions state
  const [aiSessions, setAISessions] = useState<AISession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // TOC state
  const [tocItems, setTocItems] = useState<TOCItem[]>([]);

  // Document type state (for markdown files)
  const [currentDocumentType, setCurrentDocumentType] = useState<string | null>(null);

  // Refs for click-outside handling
  const aiSessionsButtonRef = useRef<HTMLButtonElement>(null);
  const tocButtonRef = useRef<HTMLButtonElement>(null);

  // Load AI sessions
  const loadAISessions = useCallback(async () => {
    if (!filePath || !workspaceId || !(window as any).electronAPI) return;

    setLoadingSessions(true);
    try {
      const sessions = await (window as any).electronAPI.invoke('sessions:get-by-file', workspaceId, filePath);
      setAISessions(sessions || []);
    } catch (error) {
      console.error('Failed to load AI sessions:', error);
      setAISessions([]);
    } finally {
      setLoadingSessions(false);
    }
  }, [filePath, workspaceId]);

  // Load sessions when dropdown opens
  useEffect(() => {
    if (showAISessions && aiSessions.length === 0) {
      loadAISessions();
    }
  }, [showAISessions, aiSessions.length, loadAISessions]);

  // Extract TOC from Lexical editor
  const extractTOC = useCallback(() => {
    if (!lexicalEditor) return;
    if (typeof lexicalEditor.getEditorState !== 'function') return;

    try {
      lexicalEditor.getEditorState().read(() => {
        const root = $getRoot();
        const items: TOCItem[] = [];

        root.getChildren().forEach((node) => {
          if ($isHeadingNode(node)) {
            const level = parseInt(node.getTag().substring(1)); // h1 -> 1, h2 -> 2, etc.
            items.push({
              text: node.getTextContent(),
              level,
              key: node.getKey(),
            });
          }
        });

        setTocItems(items);
      });
    } catch (error) {
      console.error('[UnifiedHeaderBar] Failed to extract TOC:', error);
    }
  }, [lexicalEditor]);

  // Update TOC when editor content changes
  useEffect(() => {
    if (!lexicalEditor) return;
    if (typeof lexicalEditor.registerUpdateListener !== 'function') return;

    extractTOC();

    const unregister = lexicalEditor.registerUpdateListener(() => {
      extractTOC();
    });

    return () => {
      unregister();
    };
  }, [lexicalEditor, extractTOC]);

  // Detect current document type from editor content (markdown only)
  useEffect(() => {
    // Validate that lexicalEditor is actually a Lexical editor with the expected methods
    if (!lexicalEditor || !isMarkdown) return;
    if (typeof lexicalEditor.getEditorState !== 'function' ||
        typeof lexicalEditor.registerUpdateListener !== 'function') {
      // Not a valid Lexical editor (might be switching modes)
      return;
    }

    const detectDocumentType = () => {
      try {
        lexicalEditor.getEditorState().read(() => {
          const transformers = getEditorTransformers();
          const markdown = $convertToEnhancedMarkdownString(transformers);
          const detectedType = getCurrentTrackerTypeFromMarkdown(markdown);
          setCurrentDocumentType(detectedType);
        });
      } catch (error) {
        console.error('[UnifiedHeaderBar] Failed to detect document type:', error);
      }
    };

    detectDocumentType();

    const unregister = lexicalEditor.registerUpdateListener(() => {
      detectDocumentType();
    });

    return () => {
      unregister();
    };
  }, [lexicalEditor, isMarkdown]);

  // Handle copy as markdown
  const handleCopyAsMarkdown = useCallback(() => {
    if (!lexicalEditor || typeof lexicalEditor.getEditorState !== 'function') return;

    try {
      lexicalEditor.getEditorState().read(() => {
        const transformers = getEditorTransformers();
        const markdown = $convertToEnhancedMarkdownString(transformers);

        copyToClipboard(markdown).then(() => {
          console.log('[UnifiedHeaderBar] Markdown copied to clipboard');
        }).catch((err) => {
          console.error('[UnifiedHeaderBar] Failed to copy markdown:', err);
        });
      });
    } catch (error) {
      console.error('[UnifiedHeaderBar] Failed to convert to markdown:', error);
    }
    setShowActionsMenu(false);
  }, [lexicalEditor]);

  // Handle share link
  const handleShareLink = useCallback(() => {
    if (!filePath) return;
    setShowActionsMenu(false);
    dialogRef.current?.open<ShareDialogData>(DIALOG_IDS.SHARE, {
      contentType: 'file',
      filePath,
      title: fileName,
    });
  }, [filePath, fileName]);

  // Handle export to PDF
  const handleExportToPdf = useCallback(async () => {
    if (!lexicalEditor || typeof lexicalEditor.getEditorState !== 'function') return;
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) return;

    try {
      // Show save dialog first
      const defaultPath = fileName.replace(/\.(md|markdown|txt)$/i, '.pdf');
      const outputPath = await electronAPI.showSaveDialogPdf({ defaultPath });

      if (!outputPath) {
        // User cancelled
        return;
      }

      // Generate HTML from Lexical editor
      let html = '';
      lexicalEditor.getEditorState().read(() => {
        // Cast to LexicalEditor for $generateHtmlFromNodes
        const editorAsLexical = lexicalEditor as unknown as import('lexical').LexicalEditor;
        const content = $generateHtmlFromNodes(editorAsLexical);
        html = wrapWithPrintStyles(content, fileName);
      });

      // Export to PDF via main process
      const result = await electronAPI.exportHtmlToPdf({
        html,
        outputPath,
        pageSize: 'Letter',
        generateDocumentOutline: true,
        generateTaggedPDF: true,
      });

      if (result.success) {
        console.log('[UnifiedHeaderBar] PDF exported successfully:', outputPath);
      } else {
        console.error('[UnifiedHeaderBar] PDF export failed:', result.error);
        electronAPI.showErrorDialog('Export Failed', `Failed to export PDF: ${result.error}`);
      }
    } catch (error) {
      console.error('[UnifiedHeaderBar] Failed to export to PDF:', error);
    }
    setShowActionsMenu(false);
  }, [lexicalEditor, fileName]);

  // Handle set document type
  const handleSetDocumentType = useCallback((trackerType: string) => {
    if (!lexicalEditor || typeof lexicalEditor.update !== 'function') return;

    const isLegacy = trackerType === 'plan' || trackerType === 'decision';
    const modelDefaults = isLegacy ? undefined : getModelDefaults(trackerType);

    try {
      lexicalEditor.update(() => {
        const transformers = getEditorTransformers();
        const markdown = $convertToEnhancedMarkdownString(transformers);
        const updatedMarkdown = applyTrackerTypeToMarkdown(markdown, trackerType, modelDefaults);
        $convertFromEnhancedMarkdownString(updatedMarkdown, transformers);

        // Mark as dirty - autosave will handle saving
        if (onDirtyChange) {
          onDirtyChange(true);
        }
      });

      // Notify DocumentService so tracker UI updates immediately
      const documentService = getDocumentService();
      if (isLegacy) {
        const frontmatterKey = trackerType === 'plan' ? 'planStatus' : 'decisionStatus';
        const defaultData = getDefaultFrontmatterForType(trackerType);
        documentService.notifyFrontmatterChanged?.(filePath, { [frontmatterKey]: defaultData });
      } else {
        // Generic: top-level fields + trackerStatus only holds type
        const frontmatter: Record<string, any> = { ...(modelDefaults || {}), trackerStatus: { type: trackerType } };
        documentService.notifyFrontmatterChanged?.(filePath, frontmatter);
      }

      // Signal content changed so document header re-checks for frontmatter
      onContentChanged?.();
    } catch (error) {
      console.error('[UnifiedHeaderBar] Failed to apply document type:', error);
    }

    setShowDocTypeSubmenu(false);
    setShowActionsMenu(false);
  }, [lexicalEditor, onDirtyChange, filePath, onContentChanged]);

  // Handle remove document type
  const handleRemoveDocumentType = useCallback(() => {
    if (!lexicalEditor || typeof lexicalEditor.update !== 'function') return;

    try {
      lexicalEditor.update(() => {
        const transformers = getEditorTransformers();
        const markdown = $convertToEnhancedMarkdownString(transformers);
        const updatedMarkdown = removeTrackerTypeFromMarkdown(markdown);
        $convertFromEnhancedMarkdownString(updatedMarkdown, transformers);

        // Mark as dirty - autosave will handle saving
        if (onDirtyChange) {
          onDirtyChange(true);
        }
      });

      // Notify DocumentService so tracker UI updates immediately
      const documentService = getDocumentService();
      documentService.notifyFrontmatterChanged?.(filePath, {});

      // Signal content changed so document header re-checks for frontmatter
      onContentChanged?.();
    } catch (error) {
      console.error('[UnifiedHeaderBar] Failed to remove document type:', error);
    }

    setShowDocTypeSubmenu(false);
    setShowActionsMenu(false);
  }, [lexicalEditor, onDirtyChange, filePath, onContentChanged]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        aiSessionsButtonRef.current &&
        !aiSessionsButtonRef.current.contains(event.target as Node) &&
        !(event.target as Element).closest('.unified-header-ai-dropdown')
      ) {
        setShowAISessions(false);
      }

      if (
        tocButtonRef.current &&
        !tocButtonRef.current.contains(event.target as Node) &&
        !(event.target as Element).closest('.unified-header-toc-dropdown')
      ) {
        setShowTOC(false);
      }

    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Handle TOC item click
  const handleTOCItemClick = (key: string) => {
    if (!lexicalEditor) return;

    lexicalEditor.update(() => {
      const element = lexicalEditor.getElementByKey(key);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setShowTOC(false);
      }
    });
  };

  // Handle AI session actions
  const handleStartAgentSession = () => {
    if (onSwitchToAgentMode && filePath) {
      onSwitchToAgentMode(filePath);
    }
    setShowAISessions(false);
  };

  const handleLoadSessionInAgentMode = (sessionId: string) => {
    if (onSwitchToAgentMode) {
      onSwitchToAgentMode(undefined, sessionId);
    }
    setShowAISessions(false);
  };

  const handleLoadSessionInChat = (sessionId: string) => {
    if (onOpenSessionInChat) {
      onOpenSessionInChat(sessionId);
    }
    setShowAISessions(false);
  };

  // Format relative time
  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };
  const formatSharedTimestamp = (isoTimestamp: string): string => {
    const timestamp = new Date(isoTimestamp).getTime();
    if (Number.isNaN(timestamp)) return isoTimestamp;
    return `${new Date(timestamp).toLocaleString()} (${formatRelativeTime(timestamp)})`;
  };

  // Determine if we should show AI button (shown in both editor and agent modes)
  const shouldShowAIButton = showAIButton ?? Boolean(workspaceId);
  // Group sessions: current workspace first, then others
  const isInWorktree = workspaceId ? isWorktreePath(workspaceId) : false;
  const currentWorkspaceSessions = useMemo(() => aiSessions.filter(s => s.isCurrentWorkspace), [aiSessions]);
  const otherSessions = useMemo(() => aiSessions.filter(s => !s.isCurrentWorkspace), [aiSessions]);
  const hasGroupedSessions = currentWorkspaceSessions.length > 0 && otherSessions.length > 0;

  // Determine if we should show TOC button (Markdown only)
  const showTOCButton = isMarkdown && Boolean(lexicalEditor);

  return (
      <div className="unified-editor-header-bar h-9 min-h-9 flex items-center justify-between px-3 shrink-0 bg-[var(--nim-bg)] border-b border-[var(--nim-border)]">
      {/* Left: Breadcrumb Path */}
      {breadcrumbContent ?? <FilePathBreadcrumb filePath={filePath} workspacePath={workspaceId} />}

      {/* Right: Action Buttons */}
      <div className="unified-header-actions flex items-center gap-1">
        {/* AI Sessions Button */}
        {shouldShowAIButton && (
          <div className="unified-header-dropdown-container relative">
            <button
              ref={aiSessionsButtonRef}
              data-testid="ai-sessions-button"
              className={`unified-header-button nim-btn-icon w-7 h-7 rounded border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-150 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${
                showAISessions ? 'active bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]' : ''
              }`}
              onClick={() => {
                setShowAISessions(!showAISessions);
                if (!showAISessions) {
                  loadAISessions();
                }
              }}
              title="AI Sessions"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" opacity="0.8"/>
                <path d="M14 16L18 12L20 14L16 18M14 16L16 18L10 24H8V22L14 16Z" opacity="0.8"/>
              </svg>
            </button>

            {showAISessions && (
              <div className="unified-header-ai-dropdown absolute top-[calc(100%+4px)] right-0 min-w-[300px] max-w-[400px] overflow-hidden rounded-md z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
                {/* Dropdown header */}
                <div className="ai-sessions-header px-4 py-2.5 border-b border-[var(--nim-border)]">
                  <div className="ai-sessions-title text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
                    AI Sessions that edited this file
                  </div>
                </div>

                {loadingSessions ? (
                  <div className="ai-sessions-loading p-4 text-center text-[13px] text-[var(--nim-text-muted)]">Loading sessions...</div>
                ) : aiSessions.length > 0 ? (
                  <div className="ai-sessions-list max-h-[300px] overflow-y-auto">
                    {hasGroupedSessions ? (
                      <>
                        {/* Current workspace sessions */}
                        <div className="ai-sessions-group-header px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--nim-text-faint)] bg-[var(--nim-bg-secondary)]">
                          {isInWorktree ? 'This worktree' : 'This project'}
                        </div>
                        {currentWorkspaceSessions.map((session) => (
                          <SessionItem key={session.id} session={session} onClick={onSwitchToAgentMode ? handleLoadSessionInAgentMode : undefined} onOpenChat={onOpenSessionInChat ? handleLoadSessionInChat : undefined} formatTime={formatRelativeTime} />
                        ))}
                        {/* Other sessions */}
                        <div className="ai-sessions-group-header px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--nim-text-faint)] bg-[var(--nim-bg-secondary)]">
                          Other sessions
                        </div>
                        {otherSessions.map((session) => (
                          <SessionItem key={session.id} session={session} isLast onClick={onSwitchToAgentMode ? handleLoadSessionInAgentMode : undefined} onOpenChat={onOpenSessionInChat ? handleLoadSessionInChat : undefined} formatTime={formatRelativeTime} />
                        ))}
                      </>
                    ) : (
                      aiSessions.map((session) => (
                        <SessionItem key={session.id} session={session} isLast onClick={onSwitchToAgentMode ? handleLoadSessionInAgentMode : undefined} onOpenChat={onOpenSessionInChat ? handleLoadSessionInChat : undefined} formatTime={formatRelativeTime} />
                      ))
                    )}
                  </div>
                ) : (
                  <div className="ai-sessions-empty p-4 text-center text-[13px] text-[var(--nim-text-muted)]">No AI sessions have edited this file yet</div>
                )}

                {/* Start new session button - only shown when agent mode switch is available */}
                {onSwitchToAgentMode && (
                  <div className="ai-session-start-container px-3 py-2.5 border-t border-[var(--nim-border)]">
                    <button
                      className="ai-session-start-button w-full py-1.5 px-3 border border-[var(--nim-border)] rounded text-[13px] font-medium text-left cursor-pointer flex items-center gap-2 transition-all duration-150 text-[var(--nim-text-muted)] bg-transparent hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] hover:border-[var(--nim-primary)]"
                      onClick={handleStartAgentSession}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                      </svg>
                      Start new agent session
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TOC Button (Markdown only) */}
        {showTOCButton && (
          <div className="unified-header-dropdown-container relative">
            <button
              ref={tocButtonRef}
              className={`unified-header-button nim-btn-icon w-7 h-7 rounded border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-150 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${
                showTOC ? 'active bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]' : ''
              }`}
              onClick={() => setShowTOC(!showTOC)}
              title="Table of Contents"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6"/>
                <line x1="8" y1="12" x2="21" y2="12"/>
                <line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/>
                <line x1="3" y1="12" x2="3.01" y2="12"/>
                <line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            </button>

            {showTOC && (
              <div className="unified-header-toc-dropdown absolute top-[calc(100%+4px)] right-0 min-w-[250px] max-w-[350px] max-h-[400px] overflow-y-auto overflow-hidden rounded-md z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
                {tocItems.length > 0 ? (
                  <ul className="toc-list list-none m-0 py-1 px-0">
                    {tocItems.map((item) => (
                      <li
                        key={item.key}
                        className={`toc-item py-2 px-3 cursor-pointer text-sm leading-snug whitespace-nowrap overflow-hidden text-ellipsis transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${
                          item.level === 1
                            ? 'toc-level-1 font-semibold pl-3'
                            : item.level === 2
                            ? 'toc-level-2 pl-6'
                            : item.level === 3
                            ? 'toc-level-3 pl-9 text-[13px]'
                            : item.level === 4
                            ? 'toc-level-4 pl-12 text-[13px]'
                            : 'toc-level-5 pl-[60px] text-xs text-[var(--nim-text-muted)]'
                        }`}
                        onClick={() => handleTOCItemClick(item.key)}
                      >
                        {item.text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="toc-empty py-4 px-3 text-center text-[13px] text-[var(--nim-text-muted)]">No headings in document</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Share Link Button (markdown files only) */}
        {showShareLinkButton && (
          <button
            className="unified-header-button nim-btn-icon w-7 h-7 rounded border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-150 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            onClick={handleShareLink}
            title="Share Link"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="18" cy="5" r="3"/>
              <circle cx="6" cy="12" r="3"/>
              <circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          </button>
        )}

        {/* Shared Doc Button - local file is already linked to a team-shared doc */}
        {showSharedDocButton && sharedDocLink.binding && (
          <div className="unified-header-dropdown-container relative">
            <button
              ref={sharedDocMenu.refs.setReference}
              className={`unified-header-button unified-header-shared-linked nim-btn-icon w-7 h-7 rounded border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-150 text-[var(--nim-primary)] hover:bg-[var(--nim-bg-hover)] ${
                sharedDocMenu.isOpen ? 'active bg-[var(--nim-bg-tertiary)]' : ''
              }`}
              onClick={() => sharedDocMenu.setIsOpen(!sharedDocMenu.isOpen)}
              title="Linked to team shared document"
              {...sharedDocMenu.getReferenceProps()}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" />
                <path d="m8 17 4 4 4-4" />
                <path d="M12 12v9" />
              </svg>
            </button>

            {sharedDocMenu.isOpen && (
              <FloatingPortal>
                <div
                  ref={sharedDocMenu.refs.setFloating}
                  style={sharedDocMenu.floatingStyles}
                  className="min-w-[260px] overflow-hidden rounded-md z-[1000] py-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
                  {...sharedDocMenu.getFloatingProps()}
                >
                  <div className="px-3 py-2 border-b border-[var(--nim-border)]">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-faint)]">
                      Shared Document
                    </div>
                    <div className="mt-1 text-[13px] text-[var(--nim-text)]">
                      Shared to team on {formatSharedTimestamp(sharedDocLink.binding.createdAt)}
                    </div>
                  </div>
                  {sharedDocNameAndFolder && (
                    <button
                      className="shared-doc-open-link dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-start gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                      onClick={handleOpenSharedDoc}
                      title="Open shared document"
                    >
                      <svg className="w-4 h-4 mt-[2px] opacity-70 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                      <div className="min-w-0 flex-1 flex flex-col leading-tight">
                        <span className="shared-doc-open-link-name truncate text-[var(--nim-text)]">
                          {sharedDocNameAndFolder.name}
                        </span>
                        {sharedDocNameAndFolder.folder && (
                          <sub className="shared-doc-open-link-folder text-[11px] text-[var(--nim-text-faint)] truncate not-italic align-baseline mt-0.5">
                            {sharedDocNameAndFolder.folder}
                          </sub>
                        )}
                      </div>
                    </button>
                  )}
                  <button
                    className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={sharedDocLink.busyAction !== null}
                    onClick={async () => {
                      const success = await sharedDocLink.reuploadToSharedDoc();
                      if (success) {
                        await sharedDocLink.refresh();
                        sharedDocMenu.setIsOpen(false);
                      }
                    }}
                  >
                    <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 5 17 10" />
                      <line x1="12" y1="5" x2="12" y2="16" />
                    </svg>
                    Re-upload to Shared Doc
                  </button>
                </div>
              </FloatingPortal>
            )}
          </div>
        )}

        {/* Actions Menu Button */}
        <div className="unified-header-dropdown-container relative">
          <button
            ref={actionsMenu.refs.setReference}
            className={`unified-header-button nim-btn-icon w-7 h-7 rounded border-none bg-transparent cursor-pointer flex items-center justify-center transition-all duration-150 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${
              showActionsMenu ? 'active bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]' : ''
            }`}
            onClick={() => setShowActionsMenu(!showActionsMenu)}
            title="More actions"
            {...actionsMenu.getReferenceProps()}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="2"/>
              <circle cx="19" cy="12" r="2"/>
              <circle cx="5" cy="12" r="2"/>
            </svg>
          </button>

          {showActionsMenu && (
            <FloatingPortal>
            <div
              ref={actionsMenu.refs.setFloating}
              style={actionsMenu.floatingStyles}
              className="unified-header-actions-dropdown min-w-[220px] overflow-visible rounded-md z-[1000] py-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
              {...actionsMenu.getFloatingProps()}
            >
              {/* Toggle Source Mode */}
              {supportsSourceMode && onToggleSourceMode && (
                <button
                  className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={() => {
                    onToggleSourceMode();
                    setShowActionsMenu(false);
                  }}
                >
                  <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="16 18 22 12 16 6"/>
                    <polyline points="8 6 2 12 8 18"/>
                  </svg>
                  {isSourceModeActive ? 'Exit Source Mode' : 'Toggle Source Mode'}
                </button>
              )}

              {/* View History */}
              {showHistoryAction && (
                <button
                  className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={() => {
                    openHistoryDialog(filePath);
                    setShowActionsMenu(false);
                  }}
                >
                  <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                  View History
                </button>
              )}

              {/* Copy link (shared docs only) */}
              {sharedDocDeepLinkAvailable && (
                <button
                  className="dropdown-item copy-shared-doc-link w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={handleCopyDeepLink}
                >
                  <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  Copy link
                </button>
              )}

              {/* Markdown-specific actions */}
              {isMarkdown && (
                <>
                  {/* Toggle Markdown Mode - switch to Monaco */}
                  {onToggleMarkdownMode && (
                    <button
                      className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                      onClick={() => {
                        onToggleMarkdownMode();
                        setShowActionsMenu(false);
                      }}
                    >
                      <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="16 18 22 12 16 6"/>
                        <polyline points="8 6 2 12 8 18"/>
                      </svg>
                      Toggle Markdown Mode
                    </button>
                  )}

                  {/* Copy as Markdown */}
                  {lexicalEditor && (
                    <button
                      className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                      onClick={handleCopyAsMarkdown}
                    >
                      <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                      Copy as Markdown
                    </button>
                  )}

                  {/* Export to PDF */}
                  {lexicalEditor && (
                    <button
                      className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                      onClick={handleExportToPdf}
                    >
                      <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <path d="M12 18v-6"/>
                        <path d="M9 15l3 3 3-3"/>
                      </svg>
                      Export to PDF...
                    </button>
                  )}

                  {/* Set Document Type with submenu */}
                  {lexicalEditor && (
                    <div
                      className="dropdown-item dropdown-item-with-submenu relative w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                      onMouseEnter={() => setShowDocTypeSubmenu(true)}
                      onMouseLeave={() => setShowDocTypeSubmenu(false)}
                    >
                      <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                      </svg>
                      <span className="dropdown-item-label flex-1">Set Document Type</span>
                      <span className="dropdown-item-chevron ml-auto text-sm text-[var(--nim-text-faint)]">&#8250;</span>

                      {showDocTypeSubmenu && (
                        <div className="dropdown-submenu absolute right-full left-auto top-0 min-w-[180px] py-1 rounded-md z-[1001] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
                          {TRACKER_TYPES.map((type) => (
                            <button
                              key={type.type}
                              className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSetDocumentType(type.type);
                              }}
                            >
                              <span
                                className="material-symbols-outlined opacity-70"
                                style={{ color: type.color, fontSize: '18px' }}
                              >
                                {type.icon}
                              </span>
                              <span>{type.displayName}</span>
                              {currentDocumentType === type.type && (
                                <span className="dropdown-checkmark ml-auto text-sm text-[var(--nim-primary)]">&#10003;</span>
                              )}
                            </button>
                          ))}
                          {currentDocumentType && (
                            <>
                              <div className="dropdown-divider h-px my-1 bg-[var(--nim-border)]" />
                              <button
                                className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveDocumentType();
                                }}
                              >
                                <span className="material-symbols-outlined opacity-70" style={{ fontSize: '18px' }}>
                                  close
                                </span>
                                <span>Remove Type</span>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Debug Tree (dev mode only) */}
              {isDevMode && isMarkdown && onToggleDebugTree && (
                <button
                  className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={() => {
                    onToggleDebugTree();
                    setShowActionsMenu(false);
                  }}
                >
                  <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 16v-4"/>
                    <path d="M12 8h.01"/>
                  </svg>
                  Toggle Debug Tree
                </button>
              )}

              {/* Extra shell-specific actions */}
              {extraActionItems.length > 0 && (
                <>
                  <div className="dropdown-divider h-px my-1 bg-[var(--nim-border)]" />
                  {extraActionItems.map((item, index) => (
                    <button
                      key={`extra-action-${index}-${item.label}`}
                      className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={item.disabled}
                      onClick={() => {
                        item.onClick();
                        setShowActionsMenu(false);
                      }}
                    >
                      {item.icon && (
                        <span className="material-symbols-outlined text-lg opacity-70">{item.icon}</span>
                      )}
                      {item.label}
                    </button>
                  ))}
                </>
              )}

              {/* Common file actions (Open in Default App, External Editor, Finder, Copy Path, Share) */}
              {showCommonFileActions && (
                <>
                  <div className="dropdown-divider h-px my-1 bg-[var(--nim-border)]" />
                  <CommonFileActions
                    filePath={filePath}
                    fileName={fileName}
                    onClose={() => setShowActionsMenu(false)}
                    menuItemClass="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                    separatorClass="dropdown-divider h-px my-1 bg-[var(--nim-border)]"
                    iconSize={16}
                    useButtons={true}
                  />
                </>
              )}

              {/* Extension Menu Items */}
              {extensionMenuItems.length > 0 && (
                <>
                  <div className="dropdown-divider h-px my-1 bg-[var(--nim-border)]" />
                  <div className="dropdown-section-label pt-1.5 pb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-faint)]">
                    {extensionId || 'Extension'}
                  </div>
                  {extensionMenuItems.map((item, index) => (
                    <button
                      key={index}
                      className="dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={item.disabled}
                      onClick={() => {
                        item.onClick();
                        setShowActionsMenu(false);
                      }}
                    >
                      {item.icon && (
                        <span className="material-symbols-outlined text-lg opacity-70">{item.icon}</span>
                      )}
                      {item.label}
                    </button>
                  ))}
                </>
              )}

              {/* Extension Settings Link */}
              {onOpenExtensionSettings && (
                <>
                  <div className="dropdown-divider h-px my-1 bg-[var(--nim-border)]" />
                  <button
                    className="dropdown-item settings-link w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-primary)] hover:bg-[var(--nim-bg-hover)]"
                    onClick={() => {
                      onOpenExtensionSettings();
                      setShowActionsMenu(false);
                    }}
                  >
                    <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                    Extension Settings
                  </button>
                </>
              )}
            </div>
            </FloatingPortal>
          )}
        </div>
      </div>
    </div>
  );
};
