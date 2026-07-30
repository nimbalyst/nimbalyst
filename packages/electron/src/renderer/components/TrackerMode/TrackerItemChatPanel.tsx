/**
 * "Chat" mode of the tracker document view's right panel.
 *
 * This is the ordinary `ChatSidebar`, unmodified -- the same panel a
 * collaborative document gets. Opening it next to a tracker item does not
 * create a chat "about" the item; the item rides along as document context and
 * reaches the model when a command is sent. Session selection and creation stay
 * entirely with the standard sidebar.
 */

import React, { useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { ChatSidebar } from '../ChatSidebar/ChatSidebar';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import {
  setTrackerDocumentChatSessionAtom,
  trackerModeLayoutAtom,
} from '../../store/atoms/trackers';
import { buildTrackerDocumentContext, resolveTrackerChatSessionId } from './trackerDocumentChat';

interface TrackerItemChatPanelProps {
  itemId: string;
  workspacePath: string;
  /** The panel is visible and the standard sidebar may initialize. */
  isActive: boolean;
  onFileOpen?: (filePath: string) => Promise<void> | void;
  onSwitchToAgentMode?: (sessionId?: string) => void;
}

export const TrackerItemChatPanel: React.FC<TrackerItemChatPanelProps> = ({
  itemId,
  workspacePath,
  isActive,
  onFileOpen,
  onSwitchToAgentMode,
}) => {
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const modeLayout = useAtomValue(trackerModeLayoutAtom);
  const setChatSession = useSetAtom(setTrackerDocumentChatSessionAtom);

  const documentContext = useMemo(
    () => buildTrackerDocumentContext(itemId, item),
    [itemId, item],
  );

  const sessionId = useMemo(() => resolveTrackerChatSessionId({
    pairedSessionId: modeLayout.documentChatSessions[itemId],
    sessionRegistry,
  }), [itemId, modeLayout.documentChatSessions, sessionRegistry]);

  const handleSessionIdChange = useCallback((nextSessionId: string | null) => {
    setChatSession({ itemId, sessionId: nextSessionId });
  }, [itemId, setChatSession]);

  return (
    <div className="tracker-item-chat-panel flex h-full min-h-0 flex-col" data-testid="tracker-item-chat">
      <ChatSidebar
        workspacePath={workspacePath}
        isActive={isActive}
        sessionId={sessionId}
        onSessionIdChange={handleSessionIdChange}
        documentContext={documentContext}
        onFileOpen={onFileOpen}
        onSwitchToAgentMode={onSwitchToAgentMode}
      />
    </div>
  );
};
