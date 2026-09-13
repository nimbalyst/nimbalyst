/**
 * The run of items created without closing the popup — one clickable chip each.
 *
 * Each chip reads its record live, so a team item created with only a local
 * number (`NIM.42`) updates in place when the room answers with the shared key
 * (`NIM-42`). The two are visibly different on purpose: a local number pasted
 * into a commit message must fail loudly rather than resolve to another item.
 */

import React from 'react';
import { TrackerCreationPublication } from './TrackerCreationPublication';
import { useAtomValue } from 'jotai';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  isLocalIssueKey,
  resolveDisplayIssueKey,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/localIssueKey';

const CreatedChip: React.FC<{ itemId: string; onOpenItem: (itemId: string) => void }> = ({
  itemId,
  onOpenItem,
}) => {
  const record = useAtomValue(trackerItemByIdAtom(itemId));
  const displayKey = record ? resolveDisplayIssueKey(record) : undefined;
  const keyIsShared = Boolean(record?.issueKey && !isLocalIssueKey(record.issueKey));
  const title = record ? getRecordTitle(record) : '';

  return (
    <button
      type="button"
      data-testid={`tracker-quick-create-created-${itemId}`}
      className="flex max-w-[220px] items-center gap-1 rounded bg-[var(--nim-bg)] px-1.5 py-0.5 text-[11px] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
      onClick={() => onOpenItem(itemId)}
      title={keyIsShared ? undefined : 'Local number — not a shared issue key'}
    >
      {displayKey && <span className="shrink-0 font-mono">{displayKey}</span>}
      <span className="truncate">{title}</span>
    </button>
  );
};

export const TrackerQuickCreateCreatedStrip: React.FC<{
  createdIds: string[];
  onOpenItem: (itemId: string) => void;
  workspacePath: string;
}> = ({ createdIds, onOpenItem, workspacePath }) => {
  if (createdIds.length === 0) return null;

  return (
    <div className="tracker-quick-create-created flex flex-wrap items-center gap-1 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-1.5">
      {createdIds.map((itemId) => (
        <div key={itemId} className="tracker-quick-create-created-item flex flex-wrap items-center gap-2">
          <CreatedChip itemId={itemId} onOpenItem={onOpenItem} />
          <TrackerCreationPublication workspacePath={workspacePath} itemId={itemId} />
        </div>
      ))}
    </div>
  );
};

export default TrackerQuickCreateCreatedStrip;
