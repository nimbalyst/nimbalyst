/**
 * The Vega half of a chart: validate a Vega-Lite spec, then draw it. This
 * module pulls in vega, vega-lite and vega-embed, so `VegaChart` imports it
 * dynamically the first time a chart mounts -- a page without a chart never
 * loads it.
 *
 * Expressions run through `vega-interpreter` (`ast: true`), never Vega's
 * default `new Function` evaluator: the web console's CSP has no
 * `'unsafe-eval'`, and one code path for every host is simpler than two.
 *
 * A chart is page content anyone with edit access can write, so the view is
 * built from app-owned options only and is sealed off from the network:
 *   - `usermeta` is dropped before embedding; vega-embed would otherwise merge
 *     `usermeta.embedOptions` over ours (turning `ast` off, loading a config URL).
 *   - The loader refuses every URL, so data must be inline and image marks and
 *     `href` links resolve to nothing.
 *   - Tooltips render as escaped text, never images or markup.
 * `compileChart` rejects the same vectors up front so the block can say why.
 */

import embed, { type Result as EmbedResult } from 'vega-embed';
import { expressionInterpreter } from 'vega-interpreter';
import { compile, type TopLevelSpec } from 'vega-lite';

import type { VegaLiteSpec } from './chartSpec';

export interface VegaValidation {
  /** Vega-Lite's own spec, compiled to Vega; absent when `error` is set. */
  vegaSpec?: Record<string, unknown>;
  error?: string;
  warnings: string[];
}

/**
 * Vega-Lite drops many mistakes with a console warning and draws an empty
 * chart. Compiling up front surfaces the error and the warnings so the block
 * can say what is wrong.
 */
export function validateVegaLite(spec: VegaLiteSpec, config?: Record<string, unknown>): VegaValidation {
  const warnings: string[] = [];
  // Vega-Lite reports an unknown mark as a TypeError deep in its compiler.
  const unknownMark = findUnknownMark(spec);
  if (unknownMark) return { error: `Unknown mark "${unknownMark}". Use one of: ${MARKS.join(', ')}.`, warnings };
  const logger = {
    level(): number { return 2; },
    error(...args: unknown[]) { warnings.push(args.map(String).join(' ')); return logger; },
    warn(...args: unknown[]) { warnings.push(args.map(String).join(' ')); return logger; },
    info() { return logger; },
    debug() { return logger; },
  };
  try {
    const result = compile(spec as unknown as TopLevelSpec, { config, logger: logger as never });
    return { vegaSpec: result.spec as unknown as Record<string, unknown>, warnings };
  } catch (error) {
    return { error: `Vega-Lite could not compile this spec: ${error instanceof Error ? error.message : String(error)}`, warnings };
  }
}

const MARKS = ['arc', 'area', 'bar', 'boxplot', 'circle', 'errorband', 'errorbar', 'geoshape', 'image', 'line', 'point', 'rect', 'rule', 'square', 'text', 'tick', 'trail'];

/** The first mark name, in this spec or a layered/concatenated child, that Vega-Lite does not know. */
function findUnknownMark(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return null;
  const node = spec as Record<string, unknown>;
  const mark = node.mark;
  const name = typeof mark === 'string' ? mark : mark && typeof mark === 'object' ? (mark as { type?: unknown }).type : undefined;
  if (typeof name === 'string' && !MARKS.includes(name)) return name;
  for (const key of ['layer', 'concat', 'hconcat', 'vconcat']) {
    const children = node[key];
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = findUnknownMark(child);
        if (found) return found;
      }
    }
  }
  return findUnknownMark(node.spec);
}

export interface VegaChartHandle {
  /** Sets the drawing width; for specs whose width follows the container. */
  setWidth(width: number): void;
  finalize(): void;
}

const REFUSED = 'Charts cannot load external resources; put the data inline.';

/** A Vega loader that loads nothing: no data URLs, no images, no links. */
const DENY_LOADER = {
  load: () => Promise.reject(new Error(REFUSED)),
  sanitize: () => Promise.reject(new Error(REFUSED)),
  http: () => Promise.reject(new Error(REFUSED)),
  file: () => Promise.reject(new Error(REFUSED)),
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tooltipText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * vega-tooltip's `formatTooltip`: its return value is set as innerHTML, so
 * everything is escaped here, and the `image` key (which vega-tooltip would
 * turn into an <img>) is dropped.
 */
export function formatChartTooltip(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return escapeHtml(tooltipText(value));
  const { title, image: _image, ...rest } = value as Record<string, unknown>;
  const heading = title === undefined ? '' : `<h2>${escapeHtml(tooltipText(title))}</h2>`;
  const rows = Object.entries(rest)
    .map(([key, entry]) => `<tr><td class="key">${escapeHtml(key)}</td><td class="value">${escapeHtml(tooltipText(entry))}</td></tr>`)
    .join('');
  return `${heading}${rows ? `<table>${rows}</table>` : ''}`;
}

export async function renderVegaChart(
  container: HTMLElement,
  vegaSpec: Record<string, unknown>,
  options: { dark: boolean },
): Promise<VegaChartHandle> {
  const { usermeta: _usermeta, ...appOwnedSpec } = vegaSpec;
  const result: EmbedResult = await embed(container, appOwnedSpec as never, {
    mode: 'vega',
    actions: false,
    renderer: 'svg',
    ast: true,
    expr: expressionInterpreter,
    loader: DENY_LOADER as never,
    tooltip: { theme: options.dark ? 'dark' : 'light', formatTooltip: formatChartTooltip },
  });
  const view = result.view;
  // `width: container` compiles to a width signal that only listens to window resizes.
  const signals = Array.isArray(vegaSpec.signals) ? vegaSpec.signals as Array<{ name?: string }> : [];
  const followsContainer = signals.some((signal) => signal.name === 'width' && JSON.stringify(signal).includes('containerSize'));
  return {
    setWidth(width: number) {
      if (!followsContainer || !Number.isFinite(width) || width <= 0) return;
      view.signal('width', Math.floor(width));
      void view.runAsync();
    },
    finalize() {
      result.finalize();
    },
  };
}
