/**
 * The table half of a type's page: every item of the type and its subtypes,
 * wherever each item's page lives -- the Where column says which page that
 * is. The shared view embed fed a built-in "All" view; named views are
 * created on purpose, none are derived here.
 *
 * The host wraps it in its `TrackersUIProvider`, so the rows come from the
 * host's tracker data and edits go through the host's writes.
 */
import React from 'react';
import type { CollabOpenOptions } from '../../core/index';
import type { NamedPageViewsController } from '../../../../runtime/src/editor/plugins/EmbedPlugin/namedPageViewsController';
import type { PlacedViewScope } from '../../../../runtime/src/core/placedViewUrl';
import type { PlacedViewHandoff } from './placedViewHandoff';
import { type WherePage, type WherePlacement } from '../embed/typePageWhere';
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
export declare function typePageTypeIds(typeId: string): string[];
export declare function TypePageTable({ typeId, typeLabel, rootLabel, itemPlacements, pages, itemTitle, onOpenItem, temporaryView, onClearTemporaryView, viewsController, viewScope, onPrepareViewsDocument }: TypePageTableProps): React.JSX.Element;
