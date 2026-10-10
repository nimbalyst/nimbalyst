/**
 * A query chart placed in a page ("Chart: <Type>"): the view's items grouped
 * by one field, counted or summed, drawn by the same renderer as a ```chart
 * fence. Read-only; the items are edited where they live.
 */
import { type JSX, type ReactNode } from 'react';
import type { SavedView } from '../../trackers/index';
import type { TrackerFilterField } from '../trackerFilterFields';
import type { PlacedChart } from './placedViewDefinition';
export declare function ChartViewEmbed({ view, chart, fields, height, headerActions, headerNotice }: {
    view: SavedView;
    chart: PlacedChart;
    /** The same field catalog the definition was validated against. */
    fields: readonly TrackerFilterField[];
    /** The chart's height; unset uses the renderer's default. */
    height?: number;
    headerActions?: ReactNode;
    headerNotice?: ReactNode;
}): JSX.Element;
