import React from 'react';

export const EmptyWorkstreamState: React.FC<{ onNewSession: () => void }> = ({
  onNewSession,
}) => (
  <div
    className="workstream-session-tabs-empty flex flex-1 flex-col items-center justify-center gap-3 text-[var(--nim-text-muted)] text-sm"
    data-testid="workstream-session-tabs-empty"
  >
    <p>This workstream has no sessions.</p>
    <button className="nim-btn nim-btn-primary" onClick={onNewSession}>
      New session
    </button>
  </div>
);
