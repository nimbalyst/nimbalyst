/**
 * A typed page laid out as a document page, not the tracker detail pane. Top
 * to bottom: the crumb (where the page sits in the Pages tree), the title, one
 * row of the type chip and the single-valued fields, the body, and the Links
 * section.
 *
 * Shared by the desktop and the web console. The host owns the data: it
 * passes the item, the crumb and the field values, saves edits through
 * `onRename` and `onUpdateField`, renders the body (`renderBody`), and says
 * where the links come from (`linksSource`).
 */

import React, { useMemo } from 'react';
import type { CollabOpenOptions } from '@nimbalyst/collab-client/core';
import type { FieldDefinition } from '@nimbalyst/tracker-schema';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { TrackerTypeRow } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerTypeRow';
import type { TrackerFieldPills } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldPills';
import { NEUTRAL_SWATCH, TYPE_COLORS } from '../board/trackerBoardTokens';
import type { PageLinksSource } from './pageLinks';
import type { TrackerPageCrumb } from './trackerPageCrumb';
import { TrackerLinksSection } from './TrackerLinksSection';
import { PageHistoryButton } from './PageHistoryButton';
import { PageHeaderBar, type PageHeaderMenuItem } from './PageHeaderBar';
import { PageFacts, pageTimeFacts } from './PageFacts';
import type { PageTreeAncestor } from '../embed/pageTreeAncestors';
import { confirmDestructive } from '../../ui-primitives/confirmDestructive';
import { sanitizeTitleInput, useAutoSizedTitle } from './trackerTitleAutoSize';
import './TrackerPageView.css';

type FieldPillsProps = React.ComponentProps<typeof TrackerFieldPills>;

export interface TrackerPageViewProps {
  /** Null while the item is loading or after it is gone. */
  item: TrackerRecord | null;
  /** Whether the host has loaded its items: a missing item then reads as gone. */
  loaded: boolean;
  /** Where the page sits; `section` ("Personal") leads the crumb when set. */
  crumb: TrackerPageCrumb & { section?: string | null };
  editable: boolean;
  /** The title as it is being edited; the host saves it. */
  title: string;
  onRename: (title: string) => void;
  /** The item's stored field values, label fields still wrapped. */
  fieldValues: Record<string, unknown>;
  onUpdateField: (field: FieldDefinition, value: unknown) => void;
  teamMembers?: FieldPillsProps['teamMembers'];
  onCreateCollection?: FieldPillsProps['onCreateCollection'];
  /** The body editor, or what stands in for it while it loads. */
  renderBody: () => React.ReactNode;
  /** Above the body, in the text gutter (a recovered description, a notice). */
  beforeBody?: React.ReactNode;
  linksSource?: PageLinksSource | null;
  /** Bumped by the host after a save that may have re-indexed links. */
  linksRevision?: number;
  /** Open another typed page (a Links entry or a relationship chip). */
  onOpenItem?: (itemId: string, options?: CollabOpenOptions) => void;
  /** Open the body's page history; absent while the body has none to show. */
  onShowHistory?: () => void;
  /**
   * Archive the typed page through the tracker's archive (after an in-app
   * confirm). Absent where the host cannot write trackers.
   */
  onArchive?: () => void;
  /**
   * Draw the page's crumb, History and actions in the document header strip
   * every tab has, instead of a crumb row above the title. The crumb's pages
   * open through `onOpenAncestor`.
   */
  headerBar?: {
    onOpenAncestor?: (ancestor: PageTreeAncestor) => void;
    /** Sync and presence. */
    status?: React.ReactNode;
    /** Host buttons before History (table of contents, session chip). */
    actions?: React.ReactNode;
    /** Host actions after the page's own (Archive). */
    menuItems?: readonly PageHeaderMenuItem[];
  };
}

export const TrackerPageView: React.FC<TrackerPageViewProps> = ({
  item,
  loaded,
  crumb,
  editable,
  title: localTitle,
  onRename,
  fieldValues: storedValues,
  onUpdateField,
  teamMembers,
  onCreateCollection,
  renderBody,
  beforeBody,
  linksSource,
  linksRevision = 0,
  onOpenItem,
  onShowHistory,
  onArchive,
  headerBar,
}) => {
  const model = useMemo(() => globalRegistry.get(item?.primaryType ?? ''), [item?.primaryType]);
  const titleRef = useAutoSizedTitle(localTitle);

  if (!item) {
    return (
      <div className="tracker-page-view flex h-full items-center justify-center bg-nim text-sm text-nim-faint" data-testid="tracker-page-view">
        {loaded ? 'This page is no longer available' : 'Loading…'}
      </div>
    );
  }

  const title = getRecordTitle(item);
  const typeName = model?.displayName || item.primaryType;
  const confirmArchive = onArchive && (() => {
    void confirmDestructive(
      'Archive page',
      `Archive "${title}"? It leaves the Wiki and its type's table, with its comments and sessions kept. Restore it from its tracker's Archived view.`,
      'Archive',
    ).then((accepted) => { if (accepted) onArchive(); });
  });
  const typeColor = model?.color || TYPE_COLORS[item.primaryType] || NEUTRAL_SWATCH;

  return (
    <div className="tracker-page-view flex h-full min-h-0 flex-col overflow-hidden bg-nim" data-testid="tracker-page-view" data-item-id={item.id}>
      {headerBar && (
        <PageHeaderBar
          section={crumb.section}
          path={crumb.path ?? []}
          title={localTitle || title}
          titleIcon={model?.icon || 'label'}
          onOpenAncestor={headerBar.onOpenAncestor}
          status={item.archived
            ? <span className="tracker-page-view-archived shrink-0 px-1 text-xs text-nim-faint">Archived</span>
            : headerBar.status}
          actions={headerBar.actions}
          onShowHistory={onShowHistory}
          menuItems={[
            ...(headerBar.menuItems ?? []),
            // Last, as Move to Trash is on a plain page.
            ...(confirmArchive && !item.archived ? [{ id: 'archive', label: 'Archive page', icon: 'archive', onSelect: confirmArchive, dividerBefore: true }] : []),
          ]}
        />
      )}
      <div className="tracker-page-view-scroller min-h-0 flex-1 overflow-y-auto">
        <div className={`tracker-page-view-header${headerBar ? ' tracker-page-view-header--bar' : ''}`}>
          {!headerBar && <div className="tracker-page-view-crumb-row mb-2.5 flex items-center gap-2">
            <div className="tracker-page-view-crumb min-w-0 flex-1 truncate text-xs text-nim-faint select-text" data-testid="tracker-page-crumb">
              {[...(crumb.section ? [crumb.section] : []), ...crumb.ancestors].map((part, index) => (
                <span key={`${index}:${part}`}>{part} / </span>
              ))}
              {crumb.underType && <><span className="text-nim-muted">{typeName}</span>{' / '}</>}
              {title}
            </div>
            {item.archived
              ? <span className="tracker-page-view-archived shrink-0 text-xs text-nim-faint">Archived</span>
              : confirmArchive && (
                <button
                  type="button"
                  className="tracker-page-view-archive flex shrink-0 items-center rounded border-none bg-transparent px-1.5 py-0.5 text-nim-faint cursor-pointer hover:bg-nim-hover hover:text-nim"
                  title="Archive page"
                  aria-label="Archive page"
                  onClick={confirmArchive}
                >
                  <MaterialSymbol icon="archive" size={15} />
                </button>
              )}
            {onShowHistory && <PageHistoryButton onClick={onShowHistory} />}
          </div>}
          {editable ? (
            <textarea
              ref={titleRef}
              rows={1}
              value={localTitle}
              onChange={(e) => onRename(sanitizeTitleInput(e.target.value))}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Titles stay single-line: Enter commits instead of adding a row.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="tracker-page-view-title m-0 mb-3 w-full resize-none overflow-hidden break-words border-none bg-transparent p-0 text-[28px] font-medium leading-tight text-nim outline-none placeholder:text-nim-faint"
              placeholder="Untitled"
              data-testid="tracker-page-title"
            />
          ) : (
            <h1 className="tracker-page-view-title m-0 mb-3 break-words text-[28px] font-medium leading-tight text-nim select-text">{title}</h1>
          )}
          <TrackerTypeRow
            typeId={item.primaryType}
            values={storedValues}
            editable={editable}
            onSaveField={onUpdateField}
            typeColor={typeColor}
            resetKey={item.id}
            teamMembers={teamMembers}
            onOpenItem={onOpenItem}
            onCreateCollection={onCreateCollection}
            className="border-b border-nim pb-3"
            end={headerBar && (
              <PageFacts facts={[
                ...pageTimeFacts({ updatedAt: Date.parse(item.system.updatedAt) || null }),
                ...(item.issueKey ? [{ id: 'key', value: item.issueKey, title: 'Issue key' }] : []),
              ]} />
            )}
          />
        </div>

        {beforeBody}

        <div className="tracker-page-view-body relative" data-testid="tracker-page-body">
          {renderBody()}
        </div>

        <div className="tracker-page-view-links">
          <TrackerLinksSection
            linksSource={linksSource}
            itemId={item.id}
            itemType={item.primaryType}
            revision={linksRevision}
            onOpenItem={onOpenItem}
          />
        </div>
      </div>
    </div>
  );
};
