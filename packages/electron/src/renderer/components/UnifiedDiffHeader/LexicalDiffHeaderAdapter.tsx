/**
 * LexicalDiffHeaderAdapter
 *
 * Adapter component that connects the useLexicalDiffState hook to UnifiedDiffHeader.
 * Used by TabEditor to render the unified diff header for Lexical editors.
 */

import React from 'react';
import type { LexicalEditor } from 'lexical';
import { useLexicalDiffState } from '@nimbalyst/runtime';
import { UnifiedDiffHeader } from './UnifiedDiffHeader';
import type { SessionInfo } from './DiffCapabilities';

export interface LexicalDiffHeaderAdapterProps {
  editor: LexicalEditor | undefined;
  filePath: string;
  fileName: string;
  sessionInfo?: SessionInfo;
  onGoToSession?: (sessionId: string) => void;
}

export const LexicalDiffHeaderAdapter: React.FC<LexicalDiffHeaderAdapterProps> = ({
  editor,
  filePath,
  fileName,
  sessionInfo,
  onGoToSession,
}) => {
  const diffState = useLexicalDiffState(editor);

  if (!diffState.hasDiffs) {
    return null;
  }

  return (
    <UnifiedDiffHeader
      filePath={filePath}
      fileName={fileName}
      sessionInfo={sessionInfo}
      onGoToSession={onGoToSession}
      editorType="lexical"
      capabilities={{
        onAcceptAll: diffState.acceptAll,
        onRejectAll: diffState.rejectAll,
        changeGroups: {
          count: diffState.changeGroupCount,
          currentIndex: diffState.currentGroupIndex,
          onNavigatePrevious: diffState.navigatePrevious,
          onNavigateNext: diffState.navigateNext,
          onAcceptCurrent: diffState.acceptCurrent,
          onRejectCurrent: diffState.rejectCurrent,
        },
      }}
    />
  );
};
