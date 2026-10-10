/**
 * Session transcript embed for extension panels.
 *
 * Exposed to panels as `host.components.SessionTranscript`. The host binds the
 * workspace and file-open path; the panel supplies only the session id. The
 * composer inside sends to that session id -- SessionTranscript takes it from
 * props, never from the window's active-session state -- so a panel can show
 * a background session without changing what the agent panel is on.
 */

import type { JSX } from 'react';
import React from 'react';
import { SessionTranscript } from '../../components/UnifiedAI/SessionTranscript';

export interface PanelSessionTranscriptHostProps {
  sessionId: string;
  collapseTranscript?: boolean;
  className?: string;
  workspacePath: string;
  onOpenFile: (path: string) => void;
}

export function PanelSessionTranscript({
  sessionId,
  collapseTranscript = false,
  className,
  workspacePath,
  onOpenFile,
}: PanelSessionTranscriptHostProps): JSX.Element {
  return (
    <div
      className={`panel-session-transcript flex flex-col min-h-0 overflow-hidden ${collapseTranscript ? '' : 'h-full'} ${className ?? ''}`}
      data-session-id={sessionId}
    >
      {/* Keyed so switching sessions drops the previous session's local UI state. */}
      <SessionTranscript
        key={sessionId}
        sessionId={sessionId}
        workspacePath={workspacePath}
        mode="agent"
        hideSidebar={true}
        collapseTranscript={collapseTranscript}
        onFileClick={onOpenFile}
      />
    </div>
  );
}
