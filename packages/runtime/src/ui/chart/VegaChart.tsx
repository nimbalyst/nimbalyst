/**
 * Draws a Vega-Lite spec, themed from the `--nim-*` variables. Vega itself
 * (`./vegaRender`) loads on the first mount, so a page with no chart never
 * pays for it. A spec that does not compile shows its error in place of the
 * chart rather than an empty frame.
 *
 * Shared by the ```chart block and the "Chart: <Type>" placed view.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';

import type { VegaLiteSpec } from './chartSpec';
import { buildVegaConfig, readChartThemeColors } from './vegaTheme';

export const DEFAULT_CHART_HEIGHT = 260;

/** Changes whenever the app's theme does, including between two custom themes. */
function themeKey(): string {
  if (typeof document === 'undefined') return '';
  const root = document.documentElement;
  return `${root.getAttribute('data-theme') ?? ''}|${root.className}`;
}

function subscribeTheme(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  return () => observer.disconnect();
}

/** A spec that sizes itself to the block: the given height, the container's width. */
function sized(spec: VegaLiteSpec, height: number): VegaLiteSpec {
  const unit = spec.mark !== undefined && spec.facet === undefined && spec.repeat === undefined;
  if (!unit) return spec;
  return { ...spec, height: spec.height ?? height, width: spec.width ?? 'container' };
}

export interface VegaChartProps {
  spec: VegaLiteSpec;
  height?: number;
  className?: string;
}

export function VegaChart({ spec, height = DEFAULT_CHART_HEIGHT, className }: VegaChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => '');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const specKey = JSON.stringify(spec);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let handle: { setWidth(width: number): void; finalize(): void } | null = null;
    let observer: ResizeObserver | null = null;
    setLoading(true);
    void (async () => {
      try {
        const { validateVegaLite, renderVegaChart } = await import('./vegaRender');
        if (cancelled) return;
        const colors = readChartThemeColors(container);
        const validation = validateVegaLite(sized(spec, height), buildVegaConfig(colors));
        setWarnings(validation.warnings);
        if (validation.error || !validation.vegaSpec) {
          setError(validation.error ?? 'This chart could not be drawn.');
          container.replaceChildren();
          return;
        }
        const next = await renderVegaChart(container, validation.vegaSpec, { dark: colors.dark });
        if (cancelled) {
          next.finalize();
          return;
        }
        handle = next;
        setError(null);
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver((entries) => handle?.setWidth(entries[0]?.contentRect.width ?? 0));
          observer.observe(container);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      observer?.disconnect();
      handle?.finalize();
    };
    // `specKey` stands in for `spec`, whose identity changes on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, height, theme]);

  return (
    <div className={`vega-chart relative w-full ${className ?? ''}`} data-testid="vega-chart">
      <div
        ref={containerRef}
        className={`vega-chart-canvas w-full ${error ? 'hidden' : ''}`}
        style={{ minHeight: loading && !error ? height : undefined }}
      />
      {error ? (
        <div role="alert" className="vega-chart-error rounded border border-nim bg-nim-tertiary px-3 py-2 font-mono text-xs text-nim-error select-text" data-testid="vega-chart-error">
          {error}
        </div>
      ) : null}
      {!error && warnings.length > 0 ? (
        <div className="vega-chart-warnings px-1 pt-1 text-[11px] text-nim-faint select-text" data-testid="vega-chart-warnings">
          {warnings.join(' ')}
        </div>
      ) : null}
    </div>
  );
}

export default VegaChart;
