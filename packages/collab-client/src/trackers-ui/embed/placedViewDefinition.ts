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

import { decodeViewAttrValue, type PlacedViewScope } from '@nimbalyst/runtime/core/placedViewUrl';
import type { QuadrantPin } from '@nimbalyst/runtime/core/quadrantModel';
import type { TrackerFieldFilter } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  createDefaultViewDefinition,
  STATUS_CHANGED_FROM_FILTER_FIELD,
  STATUS_CHANGED_TO_FILTER_FIELD,
  type SavedView,
} from '@nimbalyst/collab-client/trackers';
import { READINESS_FILTER_FIELD } from '@nimbalyst/tracker-schema';
import { getDefaultColumnConfig } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import type { TrackerFilterField } from '../trackerFilterFields';

export interface PlacedQuadrant {
  xField: string;
  yField: string;
  xLabel?: string;
  yLabel?: string;
  quadrants?: string[];
  pins: QuadrantPin[];
}

export const PLACED_CHART_TYPES = ['bar', 'line', 'area', 'pie'] as const;
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

const CHART_GROUP_FIELD_TYPES = ['select', 'user', 'boolean', 'date', 'datetime'];
/** Catalog fields whose value depends on the viewer or on history, which a chart's rows do not carry. */
const CHART_CONTEXTUAL_FIELDS = new Set(['favorite', 'viewed', READINESS_FILTER_FIELD, STATUS_CHANGED_TO_FILTER_FIELD, STATUS_CHANGED_FROM_FILTER_FIELD]);

function placedChart(attrs: Readonly<Record<string, string>>, fields?: readonly TrackerFilterField[]): PlacedChart {
  const type = attrs.chart ?? 'bar';
  if (!(PLACED_CHART_TYPES as readonly string[]).includes(type)) throw new Error(`Unknown chart type: ${type}. Use ${PLACED_CHART_TYPES.join(', ')}.`);
  if (!attrs.by) throw new Error('A chart needs by=<field> to group items by.');
  if (fields) {
    const by = fields.find(candidate => candidate.id === attrs.by);
    if (!by || by.multiValue || CHART_CONTEXTUAL_FIELDS.has(by.id) || !CHART_GROUP_FIELD_TYPES.includes(by.type ?? '')) throw new Error(`Cannot chart by "${attrs.by}": pick a single select, person, yes/no or date field.`);
    if (attrs.sum) {
      const sum = fields.find(candidate => candidate.id === attrs.sum);
      if (!sum || sum.type !== 'number') throw new Error(`Cannot sum "${attrs.sum}": pick a number field.`);
    }
  }
  return { type: type as PlacedChartType, by: attrs.by, ...(attrs.sum ? { sum: attrs.sum } : {}) };
}

function list(value: string | undefined, separator: string): string[] {
  return (value ?? '').split(separator).map((part) => part.trim()).filter(Boolean);
}

function filterClauses(value: string | undefined, fields?: readonly TrackerFilterField[]): TrackerFieldFilter[] {
  if (value === undefined || value === '') return [];
  return value.split(',').map((rawClause) => {
    const clause = rawClause.trim();
    const colon = clause.indexOf(':');
    const field = clause.slice(0, colon).trim();
    const raw = clause.slice(colon + 1);
    const invalid = (reason: string): never => { throw new Error(`Invalid filter "${clause}": ${reason}`); };
    if (colon <= 0 || !field || !raw) invalid('use field:value, with | between alternatives.');
    const definition = fields?.find(candidate => candidate.id === field);
    if (fields && !definition) invalid(`unknown field "${field}".`);
    if (raw === 'empty' || raw === '!empty') return { field, op: raw === 'empty' ? 'is-empty' : 'is-not-empty' };
    const prefix = /^(>=|<=|>|<|!|=)/.exec(raw)?.[0] ?? '';
    const values = raw.slice(prefix.length).split('|').map(part => /^[+]\d+d$/.test(part.trim()) && (definition?.type === 'date' || definition?.type === 'datetime') ? part.trim() : decodeViewAttrValue(part.trim()));
    if (values.some(part => !part.trim())) invalid('a filter value cannot be empty.');
    const comparison = ['>', '<', '>=', '<='].includes(prefix);
    if (comparison && (values.length !== 1 || definition && !['number', 'date', 'datetime'].includes(definition.type ?? ''))) invalid('comparisons need one number or date.');
    if (definition?.type === 'number' && values.some(part => !Number.isFinite(Number(part)))) invalid('expected a number.');
    if (definition?.type === 'boolean' && values.some(part => part !== 'true' && part !== 'false')) invalid('expected true or false.');
    if ((definition?.type === 'select' || definition?.type === 'multiselect') && definition.options?.length
      && values.some(part => !definition.options!.some(option => option.value === part))) invalid('value is not an option for this field.');
    const resolved = values.map(part => {
      if (definition?.type !== 'date' && definition?.type !== 'datetime') return part;
      if (part === 'today' || /^[+-]\d+d$/.test(part)) {
        const date = new Date();
        date.setDate(date.getDate() + (part === 'today' ? 0 : parseInt(part, 10)));
        date.setHours(0, 0, 0, 0);
        return date.toISOString();
      }
      if (!Number.isFinite(Date.parse(part))) invalid('expected a date, today or a relative date such as +7d.');
      return part;
    });
    if (comparison) return { field, op: prefix as TrackerFieldFilter['op'], value: resolved[0] };
    if (prefix === '!') return values.length === 1 ? { field, op: '!=', value: resolved[0] } : { field, op: 'not-in', value: resolved };
    return values.length === 1 ? { field, op: '=', value: resolved[0] } : { field, op: 'in', value: resolved };
  });
}

function pins(value: string | undefined): QuadrantPin[] {
  return list(value, ';').flatMap((entry) => {
    const at = entry.lastIndexOf('@');
    if (at <= 0) return [];
    const [x, y] = entry.slice(at + 1).split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [{ label: decodeViewAttrValue(entry.slice(0, at)), x, y }];
  });
}

function label(value: string | undefined): string | undefined {
  return value ? decodeViewAttrValue(value) : undefined;
}

/**
 * The scopes a host's data source can show and write: its team project, and
 * whether `local` (the author's own items) means this page's items here.
 */
export interface PlacedViewReach {
  team: { orgId: string; projectId: string } | null;
  local: boolean;
}

/**
 * Whether a view of `scope` may be drawn from (and edit) the host's items. A
 * link without a scope predates console links and names no other project, so
 * it reads as the host's. With no reach declared, no scoped link is drawn.
 */
export function placedViewInReach(scope: PlacedViewScope | undefined, reach: PlacedViewReach | undefined): boolean {
  if (scope === undefined) return true;
  if (!reach) return false;
  if (scope === 'local') return reach.local;
  return reach.team !== null && reach.team.orgId === scope.orgId && reach.team.projectId === scope.projectId;
}

export function placedViewDefinition(
  typeId: string,
  name: string,
  attrs: Readonly<Record<string, string>>,
  fields?: readonly TrackerFilterField[],
): PlacedViewDefinition {
  const sorts = attrs.sort ? attrs.sort.split(',').map(clause => {
    const parts = clause.split(':');
    const field = parts[0]?.trim();
    const direction = parts[1] ?? 'desc';
    if (!field || parts.length > 2 || !['asc', 'desc'].includes(direction) || fields && !fields.some(candidate => candidate.id === field)) throw new Error(`Invalid sort: ${clause}`);
    return { field, direction: direction as 'asc' | 'desc' };
  }) : [];
  const sortBy = sorts[0]?.field;
  const direction = sorts[0]?.direction;
  if (attrs.scope && !['open', 'all'].includes(attrs.scope)) throw new Error(`Invalid scope: ${attrs.scope}`);
  const widths: Record<string, number> = {};
  for (const clause of attrs.w?.split(',') ?? []) {
    const [field, raw, extra] = clause.split(':');
    const width = Number(raw);
    if (!field || extra || !Number.isFinite(width) || width < 40 || width > 2000 || fields && !fields.some(candidate => candidate.id === field)) throw new Error(`Invalid column width: ${clause}`);
    widths[field] = width;
  }
  const columns = list(attrs.cols, ',');
  if (fields && columns.some(id => !fields.some(field => field.id === id))) throw new Error('A selected column no longer exists.');
  const clauses = filterClauses(attrs.filter, fields);
  const mode = attrs.mode ?? 'table';
  if (!['table', 'board', 'list', 'timeline', '2x2', 'chart'].includes(mode)) throw new Error(`Unknown view layout: ${mode}`);
  const group = attrs.group ?? (mode === 'board' ? 'status' : 'none');
  const builtInGroup = ['none', 'status', 'priority', 'assignee', 'type', 'tag', 'milestone', 'goal'].includes(group);
  const groupField = fields?.find(field => field.id === group);
  if (!builtInGroup && (!groupField || groupField.multiValue || !['select', 'boolean', 'user', 'relationship'].includes(groupField.type ?? ''))) throw new Error(`Unsupported grouping: ${group}`);
  if (mode === 'timeline' && fields) {
    for (const key of ['start', 'end']) {
      const id = attrs[key];
      const field = fields.find(candidate => candidate.id === id);
      if (id && (!field || field.multiValue || !['date', 'datetime'].includes(field.type ?? ''))) throw new Error(`Invalid timeline ${key} field: ${id}`);
    }
  }
  const view: SavedView = {
    id: `placed:${typeId}`,
    name: name || typeId,
    definition: {
      ...createDefaultViewDefinition(),
      selectedType: typeId,
      viewMode: mode === 'board' ? 'kanban' : mode === 'list' || mode === 'timeline' ? mode : 'table',
      groupBy: builtInGroup ? group as SavedView['definition']['groupBy'] : { kind: 'field', fieldId: group },
      sortColumns: sorts,
      ...(attrs.start || attrs.end ? { timelineFields: { ...(attrs.start ? { start: attrs.start } : {}), ...(attrs.end ? { end: attrs.end } : {}) } } : {}),
      ordering: sortBy || 'manual',
      // A placed view shows what its filters say; it does not hide closed items on its own.
      statusScope: attrs.scope === 'open' ? 'open' : 'all',
      recentlyViewedDays: null,
      ...(sortBy ? { sortBy, sortDirection: direction === 'asc' ? 'asc' as const : 'desc' as const } : {}),
      columnConfig: columns.length > 0 || Object.keys(widths).length > 0 ? { visibleColumns: columns.length ? columns : getDefaultColumnConfig(typeId).visibleColumns, columnWidths: widths } : null,
      columnFilters: clauses.length > 0 ? { combinator: 'and', clauses } : null,
    },
  };
  if (mode === 'chart') return { view, mode: 'chart', chart: placedChart(attrs, fields) };
  if (attrs.mode !== '2x2' || !attrs.x || !attrs.y) return { view, mode: mode === '2x2' ? 'table' : mode as PlacedViewDefinition['mode'] };
  const quadrants = list(attrs.q, '|').map(decodeViewAttrValue);
  return {
    view,
    mode: '2x2',
    quadrant: {
      xField: attrs.x,
      yField: attrs.y,
      ...(label(attrs.xl) ? { xLabel: label(attrs.xl) } : {}),
      ...(label(attrs.yl) ? { yLabel: label(attrs.yl) } : {}),
      ...(quadrants.length > 0 ? { quadrants } : {}),
      pins: pins(attrs.pin),
    },
  };
}
