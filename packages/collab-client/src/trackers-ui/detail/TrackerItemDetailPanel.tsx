/**
 * Read-and-edit view of one tracker item.
 *
 * Scoped hard. Desktop's `TrackerItemDetail` is 2,100 lines because the item is
 * also where a session gets launched, a worktree gets created, a pull request
 * gets opened, and a chat panel gets docked -- all desktop capabilities. What a
 * teammate needs in a browser tab is the item: its identity, its fields, its
 * body, and its thread.
 *
 * The body is a slot, not an editor. Item bodies already run through
 * `CollabLexicalProvider`, so the host mounts the `editor` bundle entry it
 * already ships (`CollabEditorMount`) and passes it in. A second editor
 * integration here would be a second cold-paint contract to get wrong: the
 * binding only paints Y.Doc events observed *after* it mounts (NIM-1764), and
 * that is a property of the mount, not of this panel.
 *
 * ## Two ordering rules, both load-bearing
 *
 * **Fields come before the body.** They used to come after it, so opening an
 * item showed the editor's "Opening this document..." placeholder exactly where
 * Status, Priority and Owner belong and pushed every field below the fold until
 * the room answered. The facts a reader opens an item for must not wait on a
 * socket. Desktop has always drawn them in this order.
 *
 * **`bodySlot` stays at one static JSX position.** Every child of the scroll
 * column below is written literally, so React reconciles the slot by a position
 * that cannot move between renders. A layout that chose its wrapper at runtime
 * -- a rail above some width, a stack below it -- would remount the binding on
 * a resize and leave the reader a silently blank editor. Width-dependent layout
 * is therefore CSS (`trackerItemDetail.css`), never a branch.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import type { TrackerMutationRejection } from '@nimbalyst/collab-client/trackers';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getTypeColor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import {
  TrackerFieldEditor,
  type TeamMemberOption,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';
import {
  getRecordTitle,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { TrackerSwatchBadge } from '../primitives/TrackerSwatchBadge';
import { TrackerRecentActivityChip } from '../TrackerRecentActivityChip';
import {
  TrackerCommentsSection,
  type TrackerCommentMutation,
} from '../TrackerCommentsSection';
import { CopyLinkButton } from './CopyLinkButton';
import { TrackerItemActionsMenu, type TrackerItemAction } from './TrackerItemActionsMenu';
import './trackerItemDetail.css';

export interface TrackerItemDetailPanelProps {
  item: TrackerRecord;
  identity: TrackerIdentity | null;
  /** Absent for a read-only permission state; the fields render, disabled. */
  onFieldChange?: (fieldName: string, value: unknown) => void | Promise<unknown>;
  commentMutate: (mutation: TrackerCommentMutation) => Promise<unknown>;
  formatTimestamp: (createdAt: number) => string;
  teamMembers?: TeamMemberOption[];
  /** The item body, mounted by the host through the shared editor entry. */
  bodySlot?: React.ReactNode;
  /**
   * Connectivity and presence for the body, drawn on the header row.
   *
   * A slot rather than a rendered status, because the two hosts report from
   * different places -- the browser publishes it up from the mounted editor
   * through a context channel, the desktop reads its own document state. What
   * matters here is only that it shares the header row instead of spending a
   * full strip of its own on one handoff link.
   */
  headerStatus?: React.ReactNode;
  /** Copied by the header's link button; omit to hide it. */
  copyLinkHref?: string;
  /** Extra header actions, behind the overflow menu. */
  overflowActions?: readonly TrackerItemAction[];
  onClose?: () => void;
  mutationRejection?: TrackerMutationRejection | null;
}

/**
 * Fields worth showing beside the body: everything the schema declares except
 * the title, which the header already renders.
 */
function detailFields(trackerType: string): FieldDefinition[] {
  const model = globalRegistry.get(trackerType);
  const titleField = resolveRoleFieldName(trackerType, 'title');
  return (model?.fields ?? []).filter((field) => field.name !== titleField);
}

export function TrackerItemDetailPanel({
  item,
  identity,
  onFieldChange,
  commentMutate,
  formatTimestamp,
  teamMembers,
  bodySlot,
  headerStatus,
  copyLinkHref,
  overflowActions,
  onClose,
  mutationRejection,
}: TrackerItemDetailPanelProps) {
  const fields = detailFields(item.primaryType);
  const readOnly = !onFieldChange;

  return (
    <div
      className="tracker-item-detail flex h-full min-h-0 flex-col bg-nim"
      data-testid="tracker-item-detail"
      data-item-id={item.id}
    >
      <div className="tracker-item-detail-header border-b border-nim px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <TrackerSwatchBadge label={item.primaryType} color={getTypeColor(item.primaryType)} />
          {item.issueKey ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-nim-faint select-text">
              {item.issueKey}
            </span>
          ) : null}
          <TrackerRecentActivityChip item={item} identity={identity} />
          {/* Everything after this is right-aligned: identity on the left,
              connectivity and actions on the right, one row. */}
          <span className="ml-auto" />
          {headerStatus}
          {copyLinkHref ? (
            <CopyLinkButton value={copyLinkHref} testId="tracker-copy-link" />
          ) : null}
          <TrackerItemActionsMenu actions={overflowActions ?? []} />
          {onClose ? (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded text-nim-faint hover:bg-nim-hover hover:text-nim"
              aria-label="Close item"
              onClick={onClose}
            >
              <MaterialSymbol icon="close" size={16} />
            </button>
          ) : null}
        </div>
        <h2 className="mt-1 truncate text-base font-semibold text-nim select-text">
          {getRecordTitle(item)}
        </h2>
      </div>

      <div className="tracker-item-detail-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="tracker-item-detail-fields grid gap-3 border-b border-nim px-4 py-3">
          {fields.map((field) => (
            <TrackerFieldEditor
              key={field.name}
              field={readOnly ? { ...field, readOnly: true } : field}
              value={item.fields[field.name]}
              onChange={(value) => onFieldChange?.(field.name, value)}
              layout="horizontal"
              teamMembers={teamMembers}
            />
          ))}
        </div>

        {bodySlot ? <div className="tracker-item-detail-body border-b border-nim">{bodySlot}</div> : null}

        <div className="px-4 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-nim-faint">
            Comments
          </div>
          <TrackerCommentsSection
            comments={item.system.comments}
            identity={identity}
            mutate={commentMutate}
            formatTimestamp={formatTimestamp}
            readOnly={readOnly}
            mutationRejection={mutationRejection}
          />
        </div>
      </div>
    </div>
  );
}
