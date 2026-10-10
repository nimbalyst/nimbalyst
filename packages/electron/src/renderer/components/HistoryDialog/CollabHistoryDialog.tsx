/**
 * CollabHistoryDialog
 *
 * Desktop host for the shared page history dialog in collab-client: the
 * controller comes from the open collaborative tab, revisions are projected
 * through the registered content adapters, and the diff renders in the
 * desktop's rich (markdown) or text diff viewer.
 */

import React, { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { previewRevisionSnapshot } from '@nimbalyst/runtime/sync';
import { themeIdAtom } from '@nimbalyst/runtime/store';
import {
  CollabHistoryDialog as SharedCollabHistoryDialog,
  type CollabHistoryDiffProps,
} from '@nimbalyst/collab-client/docs-ui/history';
import { collabHistoryControllerAtom } from '../../store/atoms/collabHistoryControllers';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { DiffPreviewEditor } from './DiffPreviewEditor';
import { TextDiffViewer } from './TextDiffViewer';

interface CollabHistoryDialogProps {
  collabUri: string;
  onClose: () => void;
}

// The diff viewers re-register their navigation hooks when these change.
const noop = () => {};

export const CollabHistoryDialog: React.FC<CollabHistoryDialogProps> = ({
  collabUri,
  onClose,
}) => {
  const getController = useAtomValue(collabHistoryControllerAtom);
  const themeId = useAtomValue(themeIdAtom);

  const renderDiff = useCallback(({ diffKey, oldText, newText, isMarkdown, onNavigationStateChange }: CollabHistoryDiffProps) => (
    isMarkdown ? (
      <DiffPreviewEditor
        key={diffKey}
        oldMarkdown={oldText}
        newMarkdown={newText}
        onNavigationStateChange={onNavigationStateChange}
        onNavigatePrevious={noop}
        onNavigateNext={noop}
        theme={themeId}
      />
    ) : (
      <TextDiffViewer
        key={diffKey}
        oldText={oldText}
        newText={newText}
        onNavigationStateChange={onNavigationStateChange}
        onNavigatePrevious={noop}
        onNavigateNext={noop}
      />
    )
  ), [themeId]);

  return (
    <SharedCollabHistoryDialog
      controller={getController(collabUri)}
      onClose={onClose}
      previewRevision={previewRevisionSnapshot}
      renderDiff={renderDiff}
      formatRelativeTime={getRelativeTimeString}
    />
  );
};
