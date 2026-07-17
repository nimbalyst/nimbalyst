/**
 * TrackerResourceEditor - Host renderer for a tracker item opened as a
 * workstream editor tab.
 *
 * This is an Electron host component (NOT an extension custom editor and NOT a
 * fake filesystem document). It reuses the existing TrackerItemDetail behavior
 * — live item subscription, local/collaborative body modes, review safeguards,
 * relationships — as the tab body. The collaborative provider is acquired via
 * TrackerItemDetail's useTrackerContentCollab → BodyDocCache, which is
 * refcounted by item id, so a tracker open in both Tracker Mode and an Agent
 * tab shares one provider.
 *
 * Content-focus layout (compact header, body fills the tab) is a later slice;
 * this renders the full detail surface in a tab-sized container.
 */

import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { TrackerItemDetail } from '../TrackerMode/TrackerItemDetail';
import {
  trackerResourceId,
  workstreamTrackerFocusAtom,
  setWorkstreamTrackerFocusAtom,
} from '../../store/atoms/workstreamState';

interface TrackerResourceEditorProps {
  trackerItemId: string;
  workspacePath?: string;
  /** Owning workstream — used to persist per-tab content-focus state. */
  workstreamId?: string;
  /** Close this tracker tab. */
  onClose: () => void;
  /** Open another tracker item (relationship/backlink) as a workstream tab. */
  onOpenTracker?: (trackerItemId: string) => void;
  /** Switch the workstream to Agent Mode for a spawned session. */
  onSwitchToAgentMode?: (sessionId: string) => void;
  onLaunchSession?: (trackerItemId: string) => void;
  onLaunchWorktree?: (trackerItemId: string) => void;
}

export const TrackerResourceEditor: React.FC<TrackerResourceEditorProps> = ({
  trackerItemId,
  workspacePath,
  workstreamId,
  onClose,
  onOpenTracker,
  onSwitchToAgentMode,
  onLaunchSession,
  onLaunchWorktree,
}) => {
  const resourceId = trackerResourceId(trackerItemId);
  const focusKey = workstreamId ? `${workstreamId}::${resourceId}` : '';
  // Persisted per-tab content-focus (survives tab switch, reopen, and restart).
  const contentFocus = useAtomValue(workstreamTrackerFocusAtom(focusKey));
  const setTrackerFocus = useSetAtom(setWorkstreamTrackerFocusAtom);
  const handleContentFocusChange = useCallback(
    (focus: boolean) => {
      if (workstreamId) setTrackerFocus({ workstreamId, resourceId, focus });
    },
    [workstreamId, resourceId, setTrackerFocus]
  );

  return (
    <div className="tracker-resource-editor flex flex-col h-full min-h-0 overflow-hidden bg-[var(--nim-bg)]">
      <TrackerItemDetail
        itemId={trackerItemId}
        workspacePath={workspacePath}
        onClose={onClose}
        onOpenItem={onOpenTracker}
        onSwitchToAgentMode={onSwitchToAgentMode}
        onLaunchSession={onLaunchSession}
        onLaunchWorktree={onLaunchWorktree}
        enableContentFocus
        contentFocus={workstreamId ? contentFocus : undefined}
        onContentFocusChange={workstreamId ? handleContentFocusChange : undefined}
      />
    </div>
  );
};
