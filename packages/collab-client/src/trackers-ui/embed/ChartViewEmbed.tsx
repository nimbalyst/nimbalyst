/**
 * A query chart placed in a page ("Chart: <Type>"): the view's items grouped
 * by one field, counted or summed, drawn by the same renderer as a ```chart
 * fence. Read-only; the items are edited where they live.
 */

import { useLayoutEffect, useMemo, useRef, type JSX, type ReactNode } from 'react';
import type { SavedView } from '@nimbalyst/collab-client/trackers';
import { compileChart } from '@nimbalyst/runtime/ui/chart/chartSpec';
import { VegaChart } from '@nimbalyst/runtime/ui/chart/VegaChart';
import { useTrackersUI } from '../TrackersUIProvider';
import { useTrackerDataSelector } from '../useTrackerData';
import { useTrackerViewRows } from '../useTrackerViewRows';
import { CHART_CATEGORY, CHART_VALUE, chartData, type ChartQuery } from './chartData';
import type { TrackerFilterField } from '../trackerFilterFields';
import type { PlacedChart } from './placedViewDefinition';

export function ChartViewEmbed({ view, chart, fields, height, headerActions, headerNotice }: {
  view: SavedView;
  chart: PlacedChart;
  /** The same field catalog the definition was validated against. */
  fields: readonly TrackerFilterField[];
  /** The chart's height; unset uses the renderer's default. */
  height?: number;
  headerActions?: ReactNode;
  headerNotice?: ReactNode;
}): JSX.Element {
  const { identity } = useTrackersUI();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { bodyRef.current?.setAttribute('data-placed-view-body', ''); }, []);
  const records = useTrackerDataSelector((state) => state.records);
  const { rows } = useTrackerViewRows(records, view.definition, { identity });
  const byField = fields.find((field) => field.id === chart.by);
  const sumField = chart.sum ? fields.find((field) => field.id === chart.sum) : undefined;
  // The parent rebuilds the catalog every render; key on its content, not its identity.
  const byKey = JSON.stringify(byField ?? null);
  const query: ChartQuery = useMemo(() => ({
    by: { id: chart.by, type: byField?.type ?? 'select', options: byField?.options },
    ...(chart.sum ? { sum: chart.sum } : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [chart.by, chart.sum, byKey]);
  const data = useMemo(() => chartData(rows, query), [rows, query]);
  const xTitle = byField?.label ?? chart.by;
  const yTitle = chart.sum ? `Sum of ${sumField?.label ?? chart.sum}` : 'Count';
  const compiled = useMemo(
    () => compileChart(
      { type: chart.type, x: CHART_CATEGORY, y: CHART_VALUE, data },
      { fieldTitles: { [CHART_CATEGORY]: xTitle, [CHART_VALUE]: yTitle } },
    ),
    [chart.type, data, xTitle, yTitle],
  );
  return (
    <div
      className="placed-view-chart my-3 flex flex-col overflow-hidden rounded-lg border border-nim bg-nim-secondary"
      contentEditable={false}
      data-testid="placed-view-chart"
    >
      <div className="placed-view-chart-head flex shrink-0 items-center gap-2.5 border-b border-nim px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate font-medium text-nim" title={view.name}>{view.name}</span>
        <span className="placed-view-query min-w-0 truncate rounded bg-nim-tertiary px-2 py-0.5 font-mono text-[11px] text-nim-muted">
          {chart.sum ? `sum of ${chart.sum}` : 'count'} by {chart.by}
        </span>
        <div className="ml-auto shrink-0">{headerActions}</div>
      </div>
      {headerNotice}
      <div ref={bodyRef} className="placed-view-chart-body bg-nim p-2">
        {rows.length === 0 ? (
          <div className="px-1 py-6 text-center text-xs text-nim-faint">No items match this view.</div>
        ) : compiled.ok ? (
          <VegaChart spec={compiled.spec} height={height} />
        ) : (
          <div role="alert" className="px-1 py-2 text-xs text-nim-error">{compiled.error}</div>
        )}
      </div>
    </div>
  );
}
