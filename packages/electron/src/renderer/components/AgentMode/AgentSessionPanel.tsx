/**
 * AgentSessionPanel - Fully encapsulated session view.
 *
 * This component owns ALL state for a single session:
 * - Session data (via sessionStoreAtom)
 * - Draft input (via sessionDraftInputAtom)
 * - Processing state (via sessionProcessingAtom)
 * - Queued prompts, todos, dialogs (local state)
 *
 * For the initial implementation, we delegate to SessionTranscript which already
 * has all the IPC handling and functionality. Later, we may merge the components
 * if needed for further optimization.
 */

import React, { memo, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { SessionTranscript, SessionTranscriptRef } from '../UnifiedAI/SessionTranscript';
import type { SerializableDocumentContext } from '../../hooks/useDocumentContext';

export interface AgentSessionPanelRef {
  focusInput: () => void;
}

export interface AgentSessionPanelProps {
  sessionId: string;
  workspacePath: string;
  onFileClick?: (filePath: string) => void;
  onClearAgentSession?: () => void;
  onCreateWorktreeSession?: (worktreeId: string) => Promise<string | null>;
  /** Static document context (scopes the "+ selection" chips to the active editor tab) */
  documentContext?: SerializableDocumentContext;
  /** Getter for document context from the workstream editor (for AI file/selection context) */
  getDocumentContext?: () => Promise<SerializableDocumentContext>;
  /** When true, collapse the transcript but keep input and dialogs visible */
  collapseTranscript?: boolean;
}

/**
 * AgentSessionPanel wraps SessionTranscript for now.
 *
 * The key encapsulation benefit is that this component is keyed by sessionId
 * and mounted/unmounted as sessions change. SessionTranscript already handles
 * all the atom subscriptions and IPC events for that session.
 */
const AgentSessionPanelComponent = forwardRef<AgentSessionPanelRef, AgentSessionPanelProps>(({
  sessionId,
  workspacePath,
  onFileClick,
  onClearAgentSession,
  onCreateWorktreeSession,
  documentContext,
  getDocumentContext,
  collapseTranscript = false,
}, ref) => {
  const transcriptRef = useRef<SessionTranscriptRef>(null);

  // Expose focusInput through ref
  useImperativeHandle(ref, () => ({
    focusInput: () => {
      transcriptRef.current?.focusInput();
    },
  }), []);

  const handleFileClick = useCallback((filePath: string) => {
    if (onFileClick) {
      onFileClick(filePath);
    }
  }, [onFileClick]);

  return (
    <div
      className={`agent-session-panel flex flex-col overflow-hidden ${collapseTranscript ? '' : 'h-full min-h-0'}`}
      data-session-id={sessionId}
    >
      <SessionTranscript
        ref={transcriptRef}
        sessionId={sessionId}
        workspacePath={workspacePath}
        mode="agent"
        hideSidebar={true}
        collapseTranscript={collapseTranscript}
        onFileClick={handleFileClick}
        onClearAgentSession={onClearAgentSession}
        onCreateWorktreeSession={onCreateWorktreeSession}
        documentContext={documentContext}
        getDocumentContext={getDocumentContext}
      />
    </div>
  );
});

AgentSessionPanelComponent.displayName = 'AgentSessionPanel';

export const AgentSessionPanel = memo(AgentSessionPanelComponent);
AgentSessionPanel.displayName = 'AgentSessionPanel';
