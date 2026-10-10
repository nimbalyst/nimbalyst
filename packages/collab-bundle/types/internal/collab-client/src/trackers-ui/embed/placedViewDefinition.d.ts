/**
 * A placed view's definition, read from its link title (Decision 22: the
 * definition lives in the page, not in a saved-view record).
 *
 *   cols=title,devFirst,realtime     visible columns, in order
 *   sort=realtime:desc               sort column and direction
 *   filter=status:open|active,tier:1 one clause per field; `|` = any of
 *   mode=2x2 x=<field> y=<field>     a 2x2 of two number fields
 *   xl= yl= q=TL|TR|BL|BR            axis and quadrant labels (percent-encoded)
 *   pin=Label@0.85,0.9;Other@0.2,0.3 extra points drawn highlighted
 *   mode=chart by=<field> [sum=<field>] [chart=bar|line|area|pie]
 *                                    items grouped by a select, person, yes/no
 *                                    or date field; counted, or a number summed
 *
 * Unknown presentation keys are ignored. Invalid filters refuse the view:
 * dropping a clause would silently answer a different question.
 */
import { type PlacedViewScope } from '../../../../runtime/src/core/placedViewUrl';
import type { QuadrantPin } from '../../../../runtime/src/core/quadrantModel';
import { type SavedView } from '../../trackers/index';
import type { TrackerFilterField } from '../trackerFilterFields';
export interface PlacedQuadrant {
    xField: string;
    yField: string;
    xLabel?: string;
    yLabel?: string;
    quadrants?: string[];
    pins: QuadrantPin[];
}
export declare const PLACED_CHART_TYPES: readonly ["bar", "line", "area", "pie"];
export type PlacedChartType = (typeof PLACED_CHART_TYPES)[number];
export interface PlacedChart {
    type: PlacedChartType;
    /** The field the items are grouped by. */
    by: string;
    /** A number field to sum; the chart counts items when absent. */
    sum?: string;
}
export interface PlacedViewDefinition {
    view: SavedView;
    mode: 'table' | 'board' | 'list' | 'timeline' | '2x2' | 'chart';
    quadrant?: PlacedQuadrant;
    chart?: PlacedChart;
}
/**
 * The scopes a host's data source can show and write: its team project, and
 * whether `local` (the author's own items) means this page's items here.
 */
export interface PlacedViewReach {
    team: {
        orgId: string;
        projectId: string;
    } | null;
    local: boolean;
}
/**
 * Whether a view of `scope` may be drawn from (and edit) the host's items. A
 * link without a scope predates console links and names no other project, so
 * it reads as the host's. With no reach declared, no scoped link is drawn.
 */
export declare function placedViewInReach(scope: PlacedViewScope | undefined, reach: PlacedViewReach | undefined): boolean;
export declare function placedViewDefinition(typeId: string, name: string, attrs: Readonly<Record<string, string>>, fields?: readonly TrackerFilterField[]): PlacedViewDefinition;
