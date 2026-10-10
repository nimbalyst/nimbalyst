/**
 * Compiles the small chart spec (what agents write in a ```chart fence, and
 * what a "Chart: <Type>" placed view builds from items) to a Vega-Lite spec.
 *
 *   type: bar | line | area | pie | scatter
 *   title: Sessions per week          (optional)
 *   x: week                           column on the x axis (pie: the slices)
 *   y: [desktop, web]                 one column, or a list = one series each
 *   data: |                           inline CSV with a header row,
 *     week,desktop,web                or a YAML list of rows
 *     W36,120,14
 *   width: 520                        (optional) block width in px; unset fills the column
 *   height: 300                       (optional) plot height in px
 *
 * Escape hatch: `vega-lite:` holds a full Vega-Lite spec (a YAML mapping or a
 * JSON string). When that spec has no `data`, the fence's `data` rows become
 * its inline values.
 *
 * Interactivity comes with the small spec: a tooltip on every mark, hover
 * highlight, click a legend entry to fade a series, and x-axis zoom/pan on
 * line, area and scatter when x is numeric or a date.
 *
 * Pure and React-free: unit-tested in node, and shared by the editor block
 * and the placed view.
 */

import { parseFenceCsv, parseFenceYaml } from '../../core/fenceBody';

export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'scatter'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export type ChartRow = Record<string, unknown>;

/** Field and value names the folded multi-series data uses. */
export const SERIES_FIELD = 'series';
export const VALUE_FIELD = 'value';

/** A Vega-Lite top-level spec; typed loosely so this module carries no vega-lite import. */
export type VegaLiteSpec = Record<string, unknown>;

export type ChartCompileResult =
  | { ok: true; spec: VegaLiteSpec }
  | { ok: false; error: string };

type FieldType = 'quantitative' | 'temporal' | 'nominal';

const DATE_PATTERN = /^\d{4}-\d{2}(-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?$/;

function fail(error: string): ChartCompileResult {
  return { ok: false, error };
}

/** The fence's `data` as rows: CSV text, or a YAML list of mappings. */
export function chartRows(data: unknown): { rows?: ChartRow[]; error?: string } {
  if (data === undefined || data === null) return {};
  if (typeof data === 'string') return { rows: parseFenceCsv(data) };
  if (Array.isArray(data) && data.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) {
    return { rows: data as ChartRow[] };
  }
  return { error: '"data" must be CSV text (data: |) or a list of rows.' };
}

function fieldType(rows: readonly ChartRow[], field: string): FieldType {
  const values = rows.map((row) => row[field]).filter((value) => value !== undefined && value !== null && value !== '');
  if (values.length === 0) return 'nominal';
  if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) return 'quantitative';
  if (values.every((value) => (typeof value === 'string' && DATE_PATTERN.test(value)) || value instanceof Date)) return 'temporal';
  return 'nominal';
}

function columnsOf(rows: readonly ChartRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

function stringList(value: unknown): string[] | null {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())) {
    return value.map((item: string) => item.trim());
  }
  return null;
}

function parseRawSpec(value: unknown): { spec?: VegaLiteSpec; error?: string } {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return { error: `"vega-lite" is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '"vega-lite" must be a Vega-Lite spec (a mapping, or a JSON object string).' };
  }
  return { spec: value as VegaLiteSpec };
}

/**
 * A raw spec is page content, so anything that reaches outside the chart is
 * refused here, where the block can say why (the renderer refuses it again).
 * Inline rows (`values`, `datasets`) and `usermeta` are not walked: a column
 * named url or href is data, not an instruction.
 */
function unsafeRawSpec(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      const found = unsafeRawSpec(node[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const entries = node as Record<string, unknown>;
  const mark = entries.mark;
  if (mark === 'image' || (mark && typeof mark === 'object' && (mark as { type?: unknown }).type === 'image')) {
    return `${path}: image marks load external files, which charts do not allow.`;
  }
  for (const [key, value] of Object.entries(entries)) {
    const at = path ? `${path}.${key}` : key;
    if (key === 'values' || key === 'datasets' || key === 'usermeta') continue;
    if (key === 'href') return `${at}: "href" links out of the page, which charts do not allow.`;
    if (key === 'url') return `${at}: data must be inline (data: |, or "values"); charts do not load URLs.`;
    if (key === 'bind' && value && typeof value === 'object' && 'element' in value) {
      return `${at}: "element" places controls outside the chart, which charts do not allow.`;
    }
    const found = unsafeRawSpec(value, at);
    if (found) return found;
  }
  return null;
}

/** `usermeta.embedOptions` would let the spec reconfigure the renderer. */
function withoutEmbedOptions(spec: VegaLiteSpec): VegaLiteSpec {
  const usermeta = spec.usermeta;
  if (!usermeta || typeof usermeta !== 'object' || !('embedOptions' in usermeta)) return spec;
  const { embedOptions: _embedOptions, ...rest } = usermeta as Record<string, unknown>;
  return { ...spec, usermeta: rest };
}

export const MIN_CHART_WIDTH = 240;
export const MIN_CHART_HEIGHT = 120;
export const MAX_CHART_HEIGHT = 1200;

export interface ChartBlockSize {
  /** The block's width in px; unset fills the column. */
  width?: number;
  /** The plot's height in px; unset uses the renderer's default. */
  height?: number;
}

/** The block size a fence's top-level `width:` / `height:` set (dragged with the block's handles). */
export function chartBlockSize(definition: Readonly<Record<string, unknown>>): ChartBlockSize {
  const size: ChartBlockSize = {};
  const { width, height } = definition;
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) size.width = Math.max(MIN_CHART_WIDTH, width);
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
    size.height = Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, height));
  }
  return size;
}

/** Compiles the text of a ```chart fence, with the block size it sets. */
export function compileChartSource(source: string): ChartCompileResult & { size: ChartBlockSize } {
  const parsed = parseFenceYaml(source);
  return parsed.ok
    ? { ...compileChart(parsed.value), size: chartBlockSize(parsed.value) }
    : { ...fail(parsed.error), size: {} };
}

export interface ChartCompileOptions {
  /** Axis and tooltip titles for columns whose key is not meant to be read (a placed view's internal keys). */
  fieldTitles?: Readonly<Record<string, string>>;
}

/** Compiles a parsed fence body (or an equivalent object) to a Vega-Lite spec. */
export function compileChart(definition: Readonly<Record<string, unknown>>, options: ChartCompileOptions = {}): ChartCompileResult {
  const { rows, error: dataError } = chartRows(definition.data);
  if (dataError) return fail(dataError);

  if (definition['vega-lite'] !== undefined) {
    const { spec, error } = parseRawSpec(definition['vega-lite']);
    if (!spec) return fail(error!);
    const unsafe = unsafeRawSpec(spec, 'vega-lite');
    if (unsafe) return fail(unsafe);
    const out: VegaLiteSpec = withoutEmbedOptions({ ...spec });
    if (out.data === undefined && rows) out.data = { values: rows };
    if (out.title === undefined && typeof definition.title === 'string') out.title = definition.title;
    return { ok: true, spec: out };
  }

  const type = definition.type;
  if (typeof type !== 'string' || !(CHART_TYPES as readonly string[]).includes(type)) {
    return fail(`"type" must be one of ${CHART_TYPES.join(', ')}${type === undefined ? '' : ` (got "${String(type)}")`}.`);
  }
  if (!rows || rows.length === 0) return fail('No data: add "data:" with a CSV header row and at least one row.');
  const x = typeof definition.x === 'string' ? definition.x.trim() : '';
  if (!x) return fail('"x" must name a column.');
  const ys = stringList(definition.y);
  if (!ys) return fail('"y" must name a column, or a list of columns for several series.');

  const columns = columnsOf(rows);
  const missing = [x, ...ys].filter((field) => !columns.includes(field));
  if (missing.length > 0) {
    return fail(`${missing.map((field) => `"${field}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the data (columns: ${columns.join(', ')}).`);
  }
  const notNumeric = ys.filter((field) => fieldType(rows, field) !== 'quantitative');
  if (notNumeric.length > 0) {
    return fail(`${notNumeric.map((field) => `"${field}"`).join(', ')} must hold numbers to plot on y.`);
  }
  if (type === 'pie' && ys.length > 1) return fail('A pie takes one "y" column.');

  return { ok: true, spec: compileSmallSpec(type as ChartType, typeof definition.title === 'string' ? definition.title : undefined, x, ys, rows, options.fieldTitles ?? {}) };
}

function compileSmallSpec(type: ChartType, title: string | undefined, x: string, ys: string[], rows: ChartRow[], fieldTitles: Readonly<Record<string, string>>): VegaLiteSpec {
  const titleOf = (field: string) => fieldTitles[field] ?? field;
  const multi = ys.length > 1;
  const yField = multi ? VALUE_FIELD : ys[0];
  const xType = fieldType(rows, x);
  const spec: VegaLiteSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    ...(title ? { title } : {}),
    width: 'container',
    data: { values: rows },
    ...(multi ? { transform: [{ fold: ys, as: [SERIES_FIELD, VALUE_FIELD] }] } : {}),
  };
  const tooltip = [
    { field: x, type: xType === 'quantitative' ? 'quantitative' : xType === 'temporal' ? 'temporal' : 'nominal', title: titleOf(x) },
    ...(multi ? [{ field: SERIES_FIELD, type: 'nominal', title: 'series' }] : []),
    { field: yField, type: 'quantitative', title: multi ? 'value' : titleOf(yField) },
  ];
  // Fade what the legend deselected, then what the pointer is not over.
  const opacity = (seriesSelectable: boolean, hover: boolean) => {
    const conditions: Array<Record<string, unknown>> = [];
    if (seriesSelectable) conditions.push({ test: { not: { param: 'legend' } }, value: 0.1 });
    if (hover) conditions.push({ test: { not: { param: 'hover' } }, value: 0.45 });
    return conditions.length > 0 ? { condition: conditions, value: 1 } : undefined;
  };

  if (type === 'pie') {
    spec.mark = { type: 'arc', tooltip: true };
    spec.params = [
      { name: 'hover', select: { type: 'point', on: 'pointerover', clear: 'pointerout' } },
      { name: 'legend', select: { type: 'point', fields: [x] }, bind: 'legend' },
    ];
    spec.encoding = {
      theta: { field: yField, type: 'quantitative', stack: true },
      color: { field: x, type: 'nominal', sort: null, title: titleOf(x) },
      opacity: opacity(true, true),
      tooltip,
    };
    return spec;
  }

  const markType = type === 'scatter' ? 'point' : type;
  const mark: Record<string, unknown> = { type: markType, tooltip: true };
  if (type === 'line') mark.point = true;
  if (type === 'scatter') mark.filled = true;
  // Translucent fills under a solid line, so overlapping series stay readable.
  if (type === 'area') Object.assign(mark, { fillOpacity: 0.3, line: true });
  spec.mark = mark;

  const params: Array<Record<string, unknown>> = [];
  // Hover picks a bar or point; on lines and areas it picks the whole series.
  const hoverFields = type === 'line' || type === 'area' ? (multi ? [SERIES_FIELD] : null) : [];
  if (hoverFields) {
    params.push({
      name: 'hover',
      select: { type: 'point', on: 'pointerover', clear: 'pointerout', ...(hoverFields.length > 0 ? { fields: hoverFields } : {}) },
    });
  }
  if (multi) params.push({ name: 'legend', select: { type: 'point', fields: [SERIES_FIELD] }, bind: 'legend' });
  if (type !== 'bar' && (xType === 'quantitative' || xType === 'temporal')) {
    params.push({ name: 'zoom', select: { type: 'interval', encodings: ['x'] }, bind: 'scales' });
  }
  if (params.length > 0) spec.params = params;

  const encoding: Record<string, unknown> = {
    x: { field: x, type: xType, title: titleOf(x), ...(xType === 'nominal' ? { sort: null } : {}) },
    // Series overlap rather than stack, as in the transcript's charts.
    y: { field: yField, type: 'quantitative', title: multi ? null : titleOf(yField), ...((type === 'bar' || type === 'area') && multi ? { stack: null } : {}) },
    tooltip,
  };
  if (multi) {
    encoding.color = { field: SERIES_FIELD, type: 'nominal', sort: ys, title: null };
    // Grouped rather than stacked bars, so each series reads against the axis.
    if (type === 'bar') encoding.xOffset = { field: SERIES_FIELD, sort: ys };
  }
  const fade = opacity(multi, Boolean(hoverFields));
  if (fade) encoding.opacity = fade;
  spec.encoding = encoding;
  return spec;
}
