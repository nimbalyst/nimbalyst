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
import {
  $convertToEnhancedMarkdownString,
  $convertFromEnhancedMarkdownString,
  getEditorTransformers,
  applyTrackerTypeToMarkdown,
  getDefaultFrontmatterForType,
  getModelDefaults,
  getCurrentTrackerTypeFromMarkdown,
  removeTrackerTypeFromMarkdown,
  type TrackerTypeInfo,
} from '@nimbalyst/runtime';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { historyDialogFileAtom } from '../../store';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';
import { getDocumentService } from '../../services/RendererDocumentService';
import { CommonFileActions } from '../CommonFileActions';
import { FeedbackBacklinkHeaderButton } from '../FeedbackRequest/FeedbackBacklinks';
import type { FeedbackRequestSubjectRef } from '../../../shared/feedbackRequestIndex';
import { DocumentSessionControl, type DocumentSessionActions } from './DocumentSessionControl';
import { SharedDocumentLinkActions, type SharedDocumentLinkTarget } from './SharedDocumentLinkActions';
import { FilePathBreadcrumb } from '../common/FilePathBreadcrumb';
// Deep path, not the `docs-ui` barrel: that barrel drags `CollabSidebar` and the
// whole shared-docs tree into every editor tab's module graph for one 40-line
// header row.
import { EditorHeaderBar, HeaderIconButton } from '@nimbalyst/collab-client/docs-ui/EditorHeaderBar';
import { HeaderTableOfContents, type TableOfContentsEditor } from './HeaderTableOfContents';
import { PageInfoToggleButton } from '../PageInfo/PageInfoToggleButton';
import { copyEditorAsMarkdown, exportEditorToPdf } from './editorExport';
import type { LexicalEditor } from 'lexical';
import { dialogRef, DIALOG_IDS } from '../../dialogs';
import type { ShareDialogData } from '../../dialogs';
import { useLocalFileSharedDocLink } from '../../hooks/useCollabLocalOrigin';
import { sharedDocumentsAtom, pendingCollabDocumentAtom, activeCollabScopeAtom, activeTeamOrgIdAtom, buildSharedDocumentDeepLink } from '../../store/atoms/collabDocuments';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { getCollabNodeName, getCollabParentPath, normalizeCollabPath } from '../CollabMode/collabTree';

/**
 * Every type a file can take: the same registry Pages types come from, so a
 * plan file and a typed page share one set of types. Plan and Decision first.
 */
function documentTypeOptions(): TrackerTypeInfo[] {
  const rank = (type: string) => (type === 'plan' ? 0 : type === 'decision' ? 1 : 2);
  return globalRegistry.getListed()
    .filter((model) => model.modes?.fullDocument)
    .map((model) => ({ type: model.type, displayName: model.displayName, icon: model.icon, color: model.color }))
    .sort((a, b) => rank(a.type) - rank(b.type) || a.displayName.localeCompare(b.displayName));
}

// Editor reference type - can be LexicalEditor or any editor with similar interface
interface EditorLike {
  getEditorState: () => { read: (fn: () => void) => void };
  registerUpdateListener: (callback: () => void) => () => void;
  getElementByKey: (key: string) => HTMLElement | null;
  update: (fn: () => void) => void;
}

interface ExtensionMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Drawn in the error color (Move to Trash). */
  destructive?: boolean;
  /** Starts a new group: a rule above it. */
  dividerBefore?: boolean;
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

  /**
   * What the host lets the user do with this document's AI sessions. Supplied
   * as one explicit bag so a host can't half-wire the control and leave inert
   * rows behind.
   */
  documentSessionActions?: DocumentSessionActions;

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
  /** The host mounts a `PageInfoPanel` beside the document. */
  showPageInfoAction?: boolean;
  showCommonFileActions?: boolean;
  /**
   * "Set Document Type" writes tracker frontmatter into the document. Shells
   * whose document is already owned by a tracker item (the tracker document
   * view) turn it off -- the type lives on the record, not in the body.
   */
  showDocumentTypeAction?: boolean;
  sharedDocumentLinkTarget?: SharedDocumentLinkTarget;
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
  documentSessionActions,
  extensionMenuItems = [],
  extraActionItems = [],
  onOpenExtensionSettings,
  onToggleDebugTree,
  onContentChanged,
  showAIButton,
  showShareLinkButton = isMarkdown,
  showSharedDocButton = true,
  showHistoryAction = true,
  showPageInfoAction = false,
  showCommonFileActions = true,
  showDocumentTypeAction = true,
  sharedDocumentLinkTarget,
}) => {
  const openHistoryDialog = useSetAtom(historyDialogFileAtom);

  // Dropdown states
  const [showDocTypeSubmenu, setShowDocTypeSubmenu] = useState(false);

  // Actions menu - uses floating-ui for portal rendering + viewport overflow protection
  const actionsMenu = useFloatingMenu({ placement: 'bottom-end' });
  const showActionsMenu = actionsMenu.isOpen;
  const setShowActionsMenu = actionsMenu.setIsOpen;
  const sharedDocMenu = useFloatingMenu({ placement: 'bottom-end' });
  const sharedDocLink = useLocalFileSharedDocLink(workspaceId ?? '', filePath);
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const teamOrgId = useAtomValue(activeTeamOrgIdAtom);
  const activeCollabScope = useAtomValue(activeCollabScopeAtom);
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
    if (!documentId || !activeCollabScope) return;
    setWindowMode('collab');
    setPendingCollabDoc({
      documentId,
      scopeKey: activeCollabScope.scopeKey,
      orgId: activeCollabScope.orgId,
      documentType: sharedDocument?.documentType ?? sharedDocLink.binding?.documentType,
      analyticsSource: 'home',
    });
    sharedDocMenu.setIsOpen(false);
  }, [
    sharedDocLink.binding?.documentId,
    sharedDocLink.binding?.documentType,
    activeCollabScope,
    sharedDocument?.documentType,
    setWindowMode,
    setPendingCollabDoc,
    sharedDocMenu,
  ]);

  // Open collaborative tabs provide their identity directly. Local files fall
  // back to their saved shared-document binding.
  const sharedDocumentDeepLink = useMemo(() => {
    if (sharedDocumentLinkTarget?.documentId && sharedDocumentLinkTarget.orgId) {
      return buildSharedDocumentDeepLink(
        sharedDocumentLinkTarget.documentId,
        sharedDocumentLinkTarget.orgId,
      );
    }
    const documentId = sharedDocLink.binding?.documentId;
    if (!documentId || !teamOrgId) return null;
    return buildSharedDocumentDeepLink(documentId, teamOrgId);
  }, [
    sharedDocumentLinkTarget?.documentId,
    sharedDocumentLinkTarget?.orgId,
    sharedDocLink.binding?.documentId,
    teamOrgId,
  ]);

  /**
   * The artifact feedback is asked about. Same two identity sources as the deep
   * link -- a collaborative tab knows its own document, a local file knows the
   * shared document it is bound to -- so a request about the shared document
   * surfaces from either side of that pair.
   */
  const feedbackSubject = useMemo<FeedbackRequestSubjectRef | null>(() => {
    const documentId = sharedDocumentLinkTarget?.documentId
      ?? sharedDocLink.binding?.documentId;
    return documentId ? { kind: 'document', sourceId: documentId } : null;
  }, [sharedDocumentLinkTarget?.documentId, sharedDocLink.binding?.documentId]);

  // Dev mode check
  const isDevMode = import.meta.env.DEV;

  // Document type state (for markdown files)
  const [currentDocumentType, setCurrentDocumentType] = useState<string | null>(null);


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
    copyEditorAsMarkdown(lexicalEditor as unknown as LexicalEditor);
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
    await exportEditorToPdf(lexicalEditor as unknown as LexicalEditor, fileName);
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

  // Determine if we should show TOC button (Markdown only)
  const showTOCButton = isMarkdown && Boolean(lexicalEditor);

  return (
    <EditorHeaderBar
      breadcrumb={breadcrumbContent ?? <FilePathBreadcrumb filePath={filePath} workspacePath={workspaceId} />}
      actions={(
        <>
        {/* AI sessions for this document: chip + caret, or a sparkle icon when there are none */}
        {shouldShowAIButton && (
          <DocumentSessionControl
            filePath={filePath}
            workspaceId={workspaceId}
            actions={documentSessionActions}
          />
        )}

        {/* TOC Button (Markdown only) */}
        {showTOCButton && lexicalEditor && <HeaderTableOfContents editor={lexicalEditor as unknown as TableOfContentsEditor} />}

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

        {/* Feedback backlinks - renders only when this document has feedback */}
        <FeedbackBacklinkHeaderButton subject={feedbackSubject} />

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
                    className="shared-doc-pull dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={sharedDocLink.busyAction !== null}
                    onClick={async () => {
                      const success = await sharedDocLink.pullFromSharedDoc();
                      if (success) {
                        await sharedDocLink.refresh();
                        sharedDocMenu.setIsOpen(false);
                      }
                    }}
                  >
                    <svg className="w-4 h-4 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="4" />
                    </svg>
                    Pull from Shared Doc
                  </button>
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

        {/* History sits just before the menu on every document and page. */}
        {showHistoryAction && (
          <HeaderIconButton label="View History" onClick={() => openHistoryDialog(filePath)} testId="editor-header-history">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
              <polyline points="3 3 3 8 8 8"/>
              <polyline points="12 7 12 12 15 14"/>
            </svg>
          </HeaderIconButton>
        )}
        {showPageInfoAction && <PageInfoToggleButton />}

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

              {/* Shared document links */}
              {sharedDocumentDeepLink && (
                <SharedDocumentLinkActions
                  deepLink={sharedDocumentDeepLink}
                  target={sharedDocumentLinkTarget}
                  onClose={() => setShowActionsMenu(false)}
                />
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
                  {lexicalEditor && showDocumentTypeAction && (
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
                        <div className="dropdown-submenu absolute right-full left-auto top-0 min-w-[180px] max-h-[360px] overflow-y-auto py-1 rounded-md z-[1001] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
                          {documentTypeOptions().map((type) => (
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
                    <React.Fragment key={`extra-action-${index}-${item.label}`}>
                    {item.dividerBefore && index > 0 && <div className="dropdown-divider h-px my-1 bg-[var(--nim-border)]" />}
                    <button
                      className={`dropdown-item w-full py-2 px-3 border-none bg-transparent text-[13px] text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed ${item.destructive ? 'text-[var(--nim-error)]' : 'text-[var(--nim-text)]'}`}
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
                    </React.Fragment>
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
        </>
      )}
    />
  );
};
