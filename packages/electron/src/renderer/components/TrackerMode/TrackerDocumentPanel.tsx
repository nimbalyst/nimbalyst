/**
 * The tracker document view's right panel: one slot, two surfaces.
 *
 * Modeled on agent mode's right panel (`edited-files` / `review` /
 * `session-chat`): the host's top bar owns show/hide and which surface is
 * showing, the panel itself just renders it. Greg's direction (plan:
 * tracker-document-mode, Layer 2): "it should be switchable like the agent
 * mode's right panel and it's top bar buttons".
 *
 * - **Chat about this item** — the standard chat sidebar, initially selecting
 *   a linked session when available (`TrackerItemChatPanel`).
 * - **Discussion** — the item's thread comments, the same component the item
 *   view renders (`TrackerCommentsSection`).
 */

import React from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { TrackerDocumentPanelMode } from '../../store/atoms/trackers';
import { TRACKER_DOCUMENT_PANEL_MODES } from './trackerDocumentPanelModes';
import { TrackerCommentsSection } from './TrackerCommentsSection';
import { TrackerItemChatPanel } from './TrackerItemChatPanel';

interface TrackerDocumentPanelProps {
  itemId: string;
  workspacePath?: string;
  mode: TrackerDocumentPanelMode;
  /** The panel is on screen and can initialize the ordinary chat sidebar. */
  isActive: boolean;
  onFileOpen?: (filePath: string) => Promise<void> | void;
  onSwitchToAgentMode?: (sessionId?: string) => void;
}

export const TrackerDocumentPanel: React.FC<TrackerDocumentPanelProps> = ({
  itemId,
  workspacePath,
  mode,
  isActive,
  onFileOpen,
  onSwitchToAgentMode,
}) => {
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  const option = TRACKER_DOCUMENT_PANEL_MODES.find((entry) => entry.id === mode)
    ?? TRACKER_DOCUMENT_PANEL_MODES[0];

  return (
    <div
      className="tracker-document-panel flex h-full min-h-0 flex-col overflow-hidden bg-nim-secondary"
      data-testid="tracker-document-panel"
      data-mode={mode}
    >
      <div className="tracker-document-panel-header flex shrink-0 items-center gap-1.5 border-b border-nim px-2 py-1.5">
        <MaterialSymbol icon={option.icon} size={15} className="text-nim-muted" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-nim">{option.label}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'chat' ? (
          workspacePath ? (
            <TrackerItemChatPanel
              itemId={itemId}
              workspacePath={workspacePath}
              isActive={isActive}
              onFileOpen={onFileOpen}
              onSwitchToAgentMode={onSwitchToAgentMode}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-nim-faint">
              Open a project to chat about this item.
            </div>
          )
        ) : (
          <div className="h-full overflow-y-auto p-2" data-testid="tracker-document-discussion">
            <TrackerCommentsSection itemId={itemId} comments={item?.system.comments} />
          </div>
        )}
      </div>
    </div>
  );
};
