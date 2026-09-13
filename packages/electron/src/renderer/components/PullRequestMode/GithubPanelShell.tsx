/**
 * GithubPanelShell — the layout shell shared by the GitHub panel's lists.
 *
 * Owns everything that is the *panel's* rather than a particular list's: the
 * ResizablePanel geometry and width persistence, the `gh` onboarding banner
 * above the detail pane, the pinned ChatSidebar rail (collapse state, width,
 * imperative handle), and the "chat follows the selection" rule.
 *
 * A list supplies its own filter sidebar, list, and detail node, plus the chat
 * context and linked sessions for whatever it currently has selected. Poll
 * lifecycles, filter vocabularies, and per-item actions stay with the list.
 */

import type { JSX, ReactNode } from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ResizablePanel } from '../AgenticCoding/ResizablePanel';
import { ChatSidebar, type ChatSidebarRef } from '../ChatSidebar';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';
import { prModeLayoutAtom, setPrModeLayoutAtom } from '../../store/atoms/pullRequests';
import { GhOnboardingBanner } from './GhOnboardingBanner';

/** Imperative access to the shell's chat rail, for the list's own actions. */
export interface GithubPanelChatHandle {
  toggleCollapsed: () => void;
  /** Uncollapse (if needed) and start a fresh chat session in the rail. */
  createNewSession: () => Promise<void>;
  /** Uncollapse (if needed) and show an existing session in the rail. */
  openSession: (sessionId: string) => void;
}

export interface GithubPanelShellProps {
  workspacePath: string;
  isActive: boolean;
  /** Optional row above the filter sidebar (the PRs / Issues switch lands here). */
  listHeader?: ReactNode;
  /** Filter sidebar for the active list. */
  sidebar?: ReactNode;
  /** The active list itself; fills the rest of the left pane. */
  list?: ReactNode;
  /** Detail for the current selection, or the list's empty state. */
  detail?: ReactNode;
  /**
   * When set, the panel renders this in place of the whole list/detail/chat
   * composition — the workspace has nothing to show (no GitHub remote). The
   * collapse state is still tracked and reported, so the title-bar chat control
   * stays accurate while the rail is absent.
   */
  placeholder?: ReactNode;
  /** Chat context for the current selection (see usePrAiContext). */
  documentContext?: SerializableDocumentContext;
  getDocumentContext?: () => Promise<SerializableDocumentContext>;
  onFileOpen?: (filePath: string) => Promise<void> | void;
  /** Identity of the current selection; null when nothing is selected. */
  selectionKey?: string | null;
  /** Sessions linked to the current selection, most recent first. */
  selectionSessions?: ReadonlyArray<{ id: string }>;
  onPanelStateChange?: (state: { chatCollapsed: boolean }) => void;
}

export const GithubPanelShell = forwardRef<GithubPanelChatHandle, GithubPanelShellProps>(
  function GithubPanelShell({
    workspacePath,
    isActive,
    listHeader,
    sidebar,
    list,
    detail,
    placeholder,
    documentContext,
    getDocumentContext,
    onFileOpen,
    selectionKey = null,
    selectionSessions,
    onPanelStateChange,
  }, ref): JSX.Element {
    const layout = useAtomValue(prModeLayoutAtom);
    const setLayout = useSetAtom(setPrModeLayoutAtom);
    const chatSidebarRef = useRef<ChatSidebarRef>(null);
    const selectionScope = JSON.stringify([workspacePath, selectionKey]);
    const [chatSelection, setChatSelection] = useState<{ key: string; id: string | null } | null>(null);
    const handleSessionIdChange = useCallback((id: string | null) => {
      setChatSelection({ key: selectionScope, id });
    }, [selectionScope]);

    const handleSidebarWidthChange = useCallback(
      (width: number) => setLayout({ sidebarWidth: width }),
      [setLayout],
    );

    const handleChatWidthChange = useCallback(
      (width: number) => setLayout({ chatWidth: width }),
      [setLayout],
    );

    const toggleChatCollapsed = useCallback(() => {
      setLayout({ chatCollapsed: !layout.chatCollapsed });
    }, [layout.chatCollapsed, setLayout]);

    const expandChat = useCallback(() => {
      if (layout.chatCollapsed) {
        setLayout({ chatCollapsed: false });
      }
    }, [layout.chatCollapsed, setLayout]);

    /**
     * Load an already-linked session into this pane's chat sidebar. Reviewing a
     * PR (or an issue) stays in this mode — jumping to Agent mode would lose the
     * detail the session is about.
     */
    const openSessionInChat = useCallback((sessionId: string) => {
      expandChat();
      chatSidebarRef.current?.loadSession(sessionId);
    }, [expandChat]);

    useEffect(() => {
      onPanelStateChange?.({ chatCollapsed: layout.chatCollapsed });
    }, [layout.chatCollapsed, onPanelStateChange]);

    useImperativeHandle(ref, () => ({
      toggleCollapsed: toggleChatCollapsed,
      createNewSession: async () => {
        expandChat();
        await chatSidebarRef.current?.createNewSession();
      },
      openSession: openSessionInChat,
    }), [expandChat, toggleChatCollapsed, openSessionInChat]);

    // Clear the old conversation on selection changes, then follow the first
    // linked session when it resolves. Explicit choices stay put within an item.
    useEffect(() => {
      if (chatSelection?.key === selectionScope && chatSelection.id) return;
      const mostRecent = selectionKey ? selectionSessions?.[0] : undefined;
      if (mostRecent) {
        chatSidebarRef.current?.loadSession(mostRecent.id);
      } else if (chatSelection?.key !== selectionScope) {
        handleSessionIdChange(null);
      }
    }, [selectionKey, selectionScope, selectionSessions, chatSelection, handleSessionIdChange]);

    // NOTE: every hook above must run before this early return, or a workspace
    // without a GitHub remote changes the hook count and React throws "Rendered
    // fewer hooks than expected".
    if (placeholder) {
      return (
        <div className="github-panel-shell pr-review-mode flex flex-col h-full w-full overflow-hidden">
          <GhOnboardingBanner />
          {placeholder}
        </div>
      );
    }

    const listPane = (
      <div className="github-panel-list-pane flex flex-col h-full w-full overflow-hidden bg-nim-secondary">
        {listHeader}
        {sidebar}
        <div className="min-h-0 flex-1 border-t border-nim">{list}</div>
      </div>
    );

    const detailPane = (
      <div className="github-panel-detail-pane flex flex-col h-full w-full overflow-hidden">
        <GhOnboardingBanner />
        <div className="flex-1 min-h-0 overflow-hidden">{detail}</div>
      </div>
    );

    // `pr-review-mode` / `pr-review-content` stay on the shell root: the panel's
    // ContentMode is still `pr-review` whichever list is showing, and those
    // markers are what existing tooling looks for.
    return (
      <div className="github-panel-shell pr-review-mode flex-1 flex flex-row overflow-hidden min-h-0">
        <div className="github-panel-content pr-review-content flex-1 min-w-0 overflow-hidden">
          <ResizablePanel
            leftPanel={listPane}
            rightPanel={detailPane}
            leftWidth={layout.sidebarWidth}
            minWidth={160}
            maxWidth={550}
            onWidthChange={handleSidebarWidthChange}
          />
        </div>
        <ChatSidebar
          ref={chatSidebarRef}
          workspacePath={workspacePath}
          sessionId={chatSelection?.key === selectionScope ? chatSelection.id : null}
          onSessionIdChange={handleSessionIdChange}
          autoInitializeSession={false}
          emptyState={<p>No related AI session</p>}
          isActive={isActive}
          isCollapsed={layout.chatCollapsed}
          onToggleCollapse={toggleChatCollapsed}
          width={layout.chatWidth}
          onWidthChange={handleChatWidthChange}
          documentContext={documentContext}
          getDocumentContext={getDocumentContext}
          onFileOpen={onFileOpen}
        />
      </div>
    );
  },
);

GithubPanelShell.displayName = 'GithubPanelShell';
