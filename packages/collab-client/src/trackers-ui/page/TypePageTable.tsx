/**
 * The table half of a type's page: every item of the type and its subtypes,
 * wherever each item's page lives -- the Where column says which page that
 * is. The shared view embed fed a built-in "All" view; named views are
 * created on purpose, none are derived here.
 *
 * The host wraps it in its `TrackersUIProvider`, so the rows come from the
 * host's tracker data and edits go through the host's writes.
 */

import React, { useMemo } from 'react';
import type { CollabOpenOptions } from '@nimbalyst/collab-client/core';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { resolveRoleFieldName } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerGridDerivedColumn } from '../grid/TrackerGridSurface';
import { typeWithSubtypes } from '../../docs/collabPageTree';
import { LazyTrackerViewEmbed as TrackerViewEmbed } from '../embed/LazyTrackerViewEmbed';
import type { NamedPageViewsController } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/namedPageViewsController';
import type { PlacedViewScope } from '@nimbalyst/runtime/core/placedViewUrl';
import { TypePageViews } from './TypePageViews';
import type { PlacedViewHandoff } from './placedViewHandoff';
import { createTypePageView } from '../embed/typePageView';
import { createItemWhereResolver, type WherePage, type WherePlacement } from '../embed/typePageWhere';

export interface TypePageTableProps {
  typeId: string;
  /** Built by the host from its editor: this entry must not load the editor graph. */
  viewsController?: NamedPageViewsController | null;
  viewScope?: PlacedViewScope;
  onPrepareViewsDocument?: () => Promise<void>;
  temporaryView?: PlacedViewHandoff | null;
  onClearTemporaryView?: () => void;
  /** The type's name, shown in Where for an item with no placement. */
  typeLabel: string;
  /** Shown in Where for an item at the root of its section ("Team", "Personal"). */
  rootLabel: string;
  /** Typed pages' placements in the section. */
  itemPlacements: readonly WherePlacement[];
  /** Every page that can be a parent, as the docs session lists them. */
  pages: readonly WherePage[];
  /** A typed page's title, for one that is a parent; null when unknown. */
  itemTitle: (itemId: string) => string | null;
  onOpenItem: (itemId: string, options?: CollabOpenOptions) => void;
}

/** The type and every type that extends it: the tree row counts them all, so the table lists them all. */
export function typePageTypeIds(typeId: string): string[] {
  return typeWithSubtypes(typeId, {
    typeExtends: (id) => globalRegistry.get(id)?.extends ?? null,
    listedTypes: () => globalRegistry.getListed().map((listed) => ({ typeId: listed.type, name: listed.displayName })),
  });
}

export function TypePageTable({ typeId, typeLabel, rootLabel, itemPlacements, pages, itemTitle, onOpenItem, temporaryView, onClearTemporaryView, viewsController, viewScope, onPrepareViewsDocument }: TypePageTableProps): React.JSX.Element {
  const model = globalRegistry.get(typeId);
  const view = useMemo(() => createTypePageView(typeId), [typeId]);
  const typeIds = useMemo(() => typePageTypeIds(typeId), [typeId, model]);
  const derivedColumns = useMemo((): TrackerGridDerivedColumn[] => {
    const where = createItemWhereResolver({ placements: itemPlacements, pages, typeLabel, rootLabel, itemTitle });
    // Right after the title column (the type's title-role field): past the
    // field columns it falls off-screen at a normal width.
    const after = resolveRoleFieldName(typeId, 'title');
    return [{ id: '__where', label: 'Where', width: 220, after, value: (row) => where(row.id) }];
  }, [itemPlacements, pages, typeLabel, rootLabel, typeId, model, itemTitle]);

  return (
    <div className="type-page-tab-table flex flex-col" data-testid="type-page-table">
      <TypePageViews typeId={typeId} controller={viewsController} scope={viewScope} temporaryView={temporaryView} onClearTemporaryView={onClearTemporaryView} onPrepareDocument={onPrepareViewsDocument} onOpenItem={onOpenItem}>
        <TrackerViewEmbed view={view} variant="page" onOpenItem={onOpenItem} derivedColumns={derivedColumns} typeIds={typeIds} />
      </TypePageViews>
    </div>
  );
}
