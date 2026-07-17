import type { JSX } from 'react';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createTextNode, $getRoot } from 'lexical';
import { $isHeadingNode } from '@lexical/rich-text';
import { $isCodeNode, CodeNode } from '@lexical/code';
import { $convertFromEnhancedMarkdownString, $convertToEnhancedMarkdownString, getEditorTransformers } from '../../markdown';
import { EditorConfig } from '../../EditorConfig';
import { copyToClipboard } from '../../../utils/clipboard';
import { useRuntimeSettings } from '../../context/RuntimeSettingsContext';
import {
  getBuiltInFullDocumentTrackerTypes,
  getDefaultFrontmatterForType,
  getModelDefaults,
  applyTrackerTypeToMarkdown,
  removeTrackerTypeFromMarkdown,
  getCurrentTrackerTypeFromMarkdown,
  type TrackerTypeInfo
} from './TrackerTypeHelper';
import './styles.css';

interface TOCItem {
  text: string;
  level: number;
  key: string;
}

interface AISession {
  id: string;
  title: string;
  provider: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface FloatingDocumentActionsPluginProps {
  config?: EditorConfig;
  filePath?: string;
  workspaceId?: string;
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  onOpenSessionInChat?: (sessionId: string) => void;
}

export default function FloatingDocumentActionsPlugin({
  config,
  filePath,
  workspaceId,
  onSwitchToAgentMode,
  onOpenSessionInChat
}: FloatingDocumentActionsPluginProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const runtimeSettings = useRuntimeSettings();
  const [showTOC, setShowTOC] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [showAISessions, setShowAISessions] = useState(false);
  const [showTrackerTypeSubmenu, setShowTrackerTypeSubmenu] = useState(false);
  const [aiSessions, setAISessions] = useState<AISession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [tocItems, setTocItems] = useState<TOCItem[]>([]);
  const [trackerTypes, setTrackerTypes] = useState<TrackerTypeInfo[]>([]);
  const [currentTrackerType, setCurrentTrackerType] = useState<string | null>(null);
  const tocButtonRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const aiSessionsButtonRef = useRef<HTMLButtonElement>(null);
  const trackerTypeSubmenuRef = useRef<HTMLDivElement>(null);

  // Check if we're in dev mode
  const isDevMode = import.meta.env.DEV;

  // Load available tracker types
  useEffect(() => {
    const types = getBuiltInFullDocumentTrackerTypes();
    setTrackerTypes(types);
  }, []);

  // Detect current tracker type from editor content
  useEffect(() => {
    const detectCurrentType = () => {
      editor.getEditorState().read(() => {
        const transformers = getEditorTransformers();
        const markdown = $convertToEnhancedMarkdownString(transformers);
        const currentType = getCurrentTrackerTypeFromMarkdown(markdown);
        setCurrentTrackerType(currentType);
      });
    };

    detectCurrentType();

    const unregister = editor.registerUpdateListener(() => {
      detectCurrentType();
    });

    return () => {
      unregister();
    };
  }, [editor]);

  // Extract TOC from editor content
  const extractTOC = useCallback(() => {
    editor.getEditorState().read(() => {
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
  }, [editor]);

  // Update TOC when editor content changes
  useEffect(() => {
    extractTOC();

    const unregister = editor.registerUpdateListener(() => {
      extractTOC();
    });

    return () => {
      unregister();
    };
  }, [editor, extractTOC]);

  // Load AI sessions when button is clicked
  const loadAISessions = useCallback(async () => {
    if (!filePath || !workspaceId || !(window as any).electronAPI) return;

    setLoadingSessions(true);
    try {
      const sessions = await (window as any).electronAPI.invoke('sessions:get-by-file', workspaceId, filePath);
      // console.log('[FloatingDocPlugin] Loaded sessions:', sessions);
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

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        tocButtonRef.current &&
        !tocButtonRef.current.contains(event.target as Node) &&
        !(event.target as Element).closest('.floating-doc-toc-dropdown')
      ) {
        setShowTOC(false);
      }

      if (
        actionsButtonRef.current &&
        !actionsButtonRef.current.contains(event.target as Node) &&
        !(event.target as Element).closest('.floating-doc-actions-dropdown')
      ) {
        setShowActionsMenu(false);
      }

      if (
        aiSessionsButtonRef.current &&
        !aiSessionsButtonRef.current.contains(event.target as Node) &&
        !(event.target as Element).closest('.floating-doc-ai-sessions-dropdown')
      ) {
        setShowAISessions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleTOCItemClick = (key: string) => {
    editor.update(() => {
      const node = editor.getEditorState()._nodeMap.get(key);
      if (node) {
        const element = editor.getElementByKey(key);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setShowTOC(false);
        }
      }
    });
  };

  const handleMarkdownMode = useCallback(() => {
    // Toggle to Monaco editor view for raw markdown editing
    if (config?.onToggleMarkdownMode) {
      config.onToggleMarkdownMode();
    }
    setShowActionsMenu(false);
  }, [config]);

  const handleViewHistory = useCallback(() => {
    if (config?.onViewHistory) {
      config.onViewHistory();
    }
    setShowActionsMenu(false);
  }, [config]);

  const handleRenameDocument = useCallback(() => {
    if (config?.onRenameDocument) {
      config.onRenameDocument();
    }
    setShowActionsMenu(false);
  }, [config]);

  const handleCopyAsMarkdown = useCallback(() => {
    editor.getEditorState().read(() => {
      const transformers = getEditorTransformers();
      const markdown = $convertToEnhancedMarkdownString(transformers);

      // Copy to clipboard
      copyToClipboard(markdown).then(() => {
        console.log('Markdown copied to clipboard');
      }).catch((err) => {
        console.error('Failed to copy markdown:', err);
      });
    });
    setShowActionsMenu(false);
  }, [editor]);

  const handleToggleDebugTree = useCallback(() => {
    runtimeSettings.toggleSetting('showTreeView');
    setShowActionsMenu(false);
  }, [runtimeSettings]);

  const handleStartAgentSession = useCallback(() => {
    if (onSwitchToAgentMode && filePath) {
      onSwitchToAgentMode(filePath);
    }
    setShowAISessions(false);
  }, [onSwitchToAgentMode, filePath]);

  const handleLoadSessionInAgentMode = useCallback((sessionId: string) => {
    if (onSwitchToAgentMode) {
      onSwitchToAgentMode(undefined, sessionId);
    }
    setShowAISessions(false);
  }, [onSwitchToAgentMode]);

  const handleLoadSessionInChat = useCallback((sessionId: string) => {
    // console.log('[FloatingDocPlugin] handleLoadSessionInChat called with sessionId:', sessionId);
    if (onOpenSessionInChat) {
      onOpenSessionInChat(sessionId);
    }
    setShowAISessions(false);
  }, [onOpenSessionInChat]);

  const handleSetTrackerType = useCallback((trackerType: string) => {
    const isLegacy = trackerType === 'plan' || trackerType === 'decision';
    const modelDefaults = isLegacy ? undefined : getModelDefaults(trackerType);

    editor.update(() => {
      const transformers = getEditorTransformers();
      const markdown = $convertToEnhancedMarkdownString(transformers);

      try {
        const updatedMarkdown = applyTrackerTypeToMarkdown(markdown, trackerType, modelDefaults);
        $convertFromEnhancedMarkdownString(updatedMarkdown, transformers);

        // Mark as dirty - autosave will handle saving
        if (config?.onDirtyChange) {
          config.onDirtyChange(true);
        }
      } catch (error) {
        console.error('Failed to apply tracker type:', error);
      }
    });

    // Notify DocumentService so tracker UI updates immediately
    if (filePath) {
      const docService = (window as any).documentService;
      if (docService?.notifyFrontmatterChanged) {
        if (isLegacy) {
          const frontmatterKey = trackerType === 'plan' ? 'planStatus' : 'decisionStatus';
          const defaultData = getDefaultFrontmatterForType(trackerType);
          docService.notifyFrontmatterChanged(filePath, { [frontmatterKey]: defaultData });
        } else {
          // Generic: top-level fields + trackerStatus only holds type
          const frontmatter: Record<string, any> = { ...(modelDefaults || {}), trackerStatus: { type: trackerType } };
          docService.notifyFrontmatterChanged(filePath, frontmatter);
        }
      }
    }

    setShowTrackerTypeSubmenu(false);
    setShowActionsMenu(false);
  }, [editor, config, filePath]);

  const handleRemoveTrackerType = useCallback(() => {
    editor.update(() => {
      const transformers = getEditorTransformers();
      const markdown = $convertToEnhancedMarkdownString(transformers);

      try {
        const updatedMarkdown = removeTrackerTypeFromMarkdown(markdown);
        $convertFromEnhancedMarkdownString(updatedMarkdown, transformers);

        // Mark as dirty - autosave will handle saving
        if (config?.onDirtyChange) {
          config.onDirtyChange(true);
        }
      } catch (error) {
        console.error('Failed to remove tracker type:', error);
      }
    });

    // Notify DocumentService so tracker UI updates immediately
    if (filePath) {
      const docService = (window as any).documentService;
      if (docService?.notifyFrontmatterChanged) {
        docService.notifyFrontmatterChanged(filePath, {});
      }
    }

    setShowTrackerTypeSubmenu(false);
    setShowActionsMenu(false);
  }, [editor, config, filePath]);

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

  return (
    <div className="floating-document-actions">
      {/* Table of Contents Button */}
      <button
        ref={tocButtonRef}
        className="floating-doc-button"
        onClick={() => setShowTOC(!showTOC)}
        aria-label="Table of Contents"
      >
        <i className="icon table-of-contents" />
      </button>

      {showTOC && (
        <div className="floating-doc-toc-dropdown">
          {tocItems.length > 0 ? (
            <ul className="toc-list">
              {tocItems.map((item) => (
                <li
                  key={item.key}
                  className={`toc-item toc-level-${item.level}`}
                  onClick={() => handleTOCItemClick(item.key)}
                >
                  {item.text}
                </li>
              ))}
            </ul>
          ) : (
            <div className="toc-empty">No headings in document</div>
          )}
        </div>
      )}

      {/* AI Sessions Button */}
      {filePath && workspaceId && onSwitchToAgentMode && (
        <>
          <button
            ref={aiSessionsButtonRef}
            className="floating-doc-button floating-doc-ai-button"
            onClick={() => {
              setShowAISessions(!showAISessions);
              if (!showAISessions) {
                loadAISessions();
              }
            }}
            aria-label="AI Sessions"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* AI Sparkle */}
              <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z" fill="currentColor" opacity="0.8"/>
              {/* Pencil */}
              <path d="M14 16L18 12L20 14L16 18M14 16L16 18L10 24H8V22L14 16Z" fill="currentColor" opacity="0.8"/>
            </svg>
            {aiSessions.length > 0 && (
              <span className="ai-sessions-badge">{aiSessions.length}</span>
            )}
          </button>

          {showAISessions && (
            <div className="floating-doc-ai-sessions-dropdown">
              <button
                className="ai-session-start-button"
                onClick={handleStartAgentSession}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM17 13H13V17H11V13H7V11H11V7H13V11H17V13Z" fill="currentColor"/>
                </svg>
                Start Agent Session
              </button>

              {loadingSessions ? (
                <div className="ai-sessions-loading">Loading sessions...</div>
              ) : aiSessions.length > 0 ? (
                <>
                  <div className="ai-sessions-divider" />
                  <div className="ai-sessions-list">
                    {aiSessions.map((session) => (
                      <div
                        key={session.id}
                        data-session-id={session.id}
                        className="ai-session-item"
                      >
                        <div className="ai-session-header">
                          <div className="ai-session-title">{session.title}</div>
                          <div className="ai-session-meta">
                            {session.provider} • {formatRelativeTime(session.updatedAt)} • {session.messageCount} turns
                          </div>
                        </div>
                        <div className="ai-session-actions">
                          <button
                              className="ai-session-action-button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleLoadSessionInAgentMode(session.id);
                              }}
                              title="Open in Agent mode"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M19 3H5C3.89 3 3 3.9 3 5V19C3 20.1 3.89 21 5 21H19C20.11 21 21 20.1 21 19V5C21 3.9 20.11 3 19 3ZM19 19H5V5H19V19Z" fill="currentColor"/>
                            </svg>
                            Agent
                          </button>
                          <button
                            className="ai-session-action-button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLoadSessionInChat(session.id);
                            }}
                            title="Open in AI Chat panel"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z" fill="currentColor"/>
                            </svg>
                            Chat
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="ai-sessions-divider" />
                  <div className="ai-sessions-empty">No AI sessions yet</div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Document Actions Menu Button */}
      <button
        ref={actionsButtonRef}
        className="floating-doc-button floating-doc-menu-button"
        onClick={() => setShowActionsMenu(!showActionsMenu)}
        aria-label="Document Actions"
      >
        ⋯
      </button>

      {showActionsMenu && (
        <div className="floating-doc-actions-dropdown">
          <button className="action-menu-item" onClick={handleMarkdownMode}>
            Toggle Markdown Mode
          </button>
          <button className="action-menu-item" onClick={handleViewHistory}>
            View History
          </button>
          {/*<button className="action-menu-item" onClick={handleRenameDocument}>*/}
          {/*  Rename Document*/}
          {/*</button>*/}
          <button className="action-menu-item" onClick={handleCopyAsMarkdown}>
            Copy as Markdown
          </button>
          <div
            className="action-menu-item action-menu-item-with-submenu"
            onMouseEnter={() => setShowTrackerTypeSubmenu(true)}
            onMouseLeave={() => setShowTrackerTypeSubmenu(false)}
          >
            <span>Set Document Type</span>
            <i className="icon chevron-right">›</i>

            {showTrackerTypeSubmenu && (
              <div className="action-menu-submenu" ref={trackerTypeSubmenuRef}>
                {trackerTypes.map((type) => (
                  <button
                    key={type.type}
                    className="action-menu-item"
                    onClick={() => handleSetTrackerType(type.type)}
                  >
                    <span className="material-symbols-outlined tracker-type-icon" style={{ color: type.color, fontSize: '18px' }}>
                      {type.icon}
                    </span>
                    <span>{type.displayName}</span>
                    {currentTrackerType === type.type && (
                      <span className="checkmark">✓</span>
                    )}
                  </button>
                ))}
                {currentTrackerType && (
                  <>
                    <div className="action-menu-divider" />
                    <button
                      className="action-menu-item"
                      onClick={handleRemoveTrackerType}
                    >
                      <span className="material-symbols-outlined tracker-type-icon" style={{ fontSize: '18px' }}>
                        close
                      </span>
                      <span>Remove Type</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {isDevMode && (
            <button className="action-menu-item" onClick={handleToggleDebugTree}>
              Toggle Debug Tree
            </button>
          )}
        </div>
      )}
    </div>
  );
}
