/**
 * A view placed in a page (a placed-view link of a type, see `placedViewUrl.ts`),
 * drawn live from the items. The definition comes from the link title
 * (`placedViewDefinition`): a table whose cells edit the items, a 2x2 of
 * two number fields with pinned extra points, or a chart of the items
 * grouped by one field.
 *
 * The host mounts it inside a `TrackersUIProvider`. Loaded lazily
 * (`LazyPlacedViewEmbed`) so a page with no view does not pay for the grid.
 */
import { type JSX } from 'react';
import type { CollabOpenOptions } from '../../core/index';
import { type PlacedViewTarget } from '../../../../runtime/src/core/placedViewUrl';
import type { SavedView } from '../../trackers/index';
import { type PlacedViewReach } from './placedViewDefinition';
import type { PlacedViewHandoff } from '../page/placedViewHandoff';
import './ViewEmbedHeader.css';
export interface PlacedViewEmbedProps {
    target: PlacedViewTarget;
    label: string;
    attrs: Readonly<Record<string, string>>;
    onAttrsChange?: (patch: Readonly<Record<string, string | null>>) => void;
    /**
     * The scopes the mounted data source serves. A link naming any other scope
     * is never drawn from (or edited through) this host's items.
     */
    reach?: PlacedViewReach;
    onOpenItem?: (itemId: string, options?: CollabOpenOptions) => void;
    onOpenAsTable?: (view: SavedView) => void;
    onOpenFullView?: (typeId: string, view: PlacedViewHandoff) => void;
    variant?: 'card' | 'page';
    settingsTemporary?: boolean;
    /** Opens the page a listed mark is on, by its tab uri. */
    onOpenPage?: (uri: string, options?: CollabOpenOptions) => void;
    /** Opens the view's own console link, for a view this host cannot draw. */
    onOpenLink?: (href: string) => void;
}
export declare function PlacedViewEmbed({ target, label, attrs, onAttrsChange, reach, onOpenItem, onOpenAsTable, onOpenFullView, variant, settingsTemporary, onOpenPage, onOpenLink }: PlacedViewEmbedProps): JSX.Element;
