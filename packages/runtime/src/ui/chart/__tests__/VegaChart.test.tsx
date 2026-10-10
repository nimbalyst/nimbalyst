/**
 * The renderer end to end in jsdom: Vega loads lazily, draws through the
 * CSP-safe expression interpreter, and a spec Vega-Lite rejects shows its
 * error in the block instead of an empty frame.
 */

import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { compileChartSource } from '../chartSpec';
import { VegaChart } from '../VegaChart';
import { formatChartTooltip, renderVegaChart, validateVegaLite } from '../vegaRender';

describe('VegaChart', () => {
  // jsdom has no canvas; Vega falls back to estimated text widths without one.
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('draws a compiled small spec as SVG', async () => {
    const compiled = compileChartSource('type: line\nx: n\ny: [a, b]\ndata: |\n  n,a,b\n  1,2,3\n  2,4,1');
    if (!compiled.ok) throw new Error(compiled.error);
    const { container } = render(<VegaChart spec={compiled.spec} />);
    await waitFor(() => expect(container.querySelector('.vega-chart-canvas svg')).not.toBeNull(), { timeout: 5000 });
    expect(screen.queryByTestId('vega-chart-error')).toBeNull();
  });

  it('shows the validation error in place of the chart', async () => {
    render(<VegaChart spec={{ mark: 'nonsense', data: { values: [{ a: 1 }] } }} />);
    expect((await screen.findByTestId('vega-chart-error')).textContent).toContain('Unknown mark "nonsense"');
  });
});

/**
 * A raw `vega-lite:` spec is authored by whoever can edit the page. `compileChart`
 * rejects the known vectors; these check the renderer holds even when a spec
 * reaches it unvalidated: no fetch, no external image or link, and nothing in
 * the spec can change how the view is built.
 */
describe('renderVegaChart isolation', () => {
  const EVIL = 'evil.example';

  async function draw(liteSpec: Record<string, unknown>) {
    const validation = validateVegaLite(liteSpec);
    if (!validation.vegaSpec) throw new Error(validation.error);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderVegaChart(container, validation.vegaSpec, { dark: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { container, handle, vegaSpec: validation.vegaSpec };
  }

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores usermeta.embedOptions: no config fetch, and expressions never reach the Function constructor', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('blocked'));
    const functionSpy = vi.spyOn(globalThis, 'Function');
    const { vegaSpec, handle } = await draw({
      usermeta: { embedOptions: { ast: false, config: `https://${EVIL}/config.json` } },
      data: { values: [{ a: 1 }, { a: 2 }] },
      mark: 'point',
      encoding: { x: { field: 'a', type: 'quantitative' } },
      params: [{ name: 'p', select: 'interval' }],
    });
    expect(vegaSpec.usermeta).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(functionSpy).not.toHaveBeenCalled();
    handle.finalize();
  });

  it('loads no data URL, external image or link', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('blocked'));
    const remote = await draw({ data: { url: `https://${EVIL}/data.csv` }, mark: 'point' });
    const links = await draw({
      data: { values: [{ u: `https://${EVIL}/x.png`, x: 1 }] },
      mark: { type: 'image', width: 10, height: 10 },
      encoding: { x: { field: 'x', type: 'quantitative' }, url: { field: 'u' }, href: { field: 'u' } },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // The URL may appear as text (an aria-label); nothing may load or link to it.
    const loadsOrLinks = [...links.container.querySelectorAll('*')].flatMap((element) =>
      ['href', 'xlink:href', 'src'].map((name) => element.getAttribute(name) ?? ''));
    expect(links.container.querySelector('image')).not.toBeNull();
    expect(loadsOrLinks.filter((value) => value.includes(EVIL))).toEqual([]);
    remote.handle.finalize();
    links.handle.finalize();
  });
});

describe('formatChartTooltip', () => {
  it('renders text only: escapes markup and never emits an image', () => {
    const html = formatChartTooltip({ title: '<b>T</b>', image: `https://evil.example/x.png`, name: '<img src=x onerror=alert(1)>', n: 3, nested: { a: 1 } });
    expect(html).not.toMatch(/<img|<b>|evil\.example/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;T&lt;/b&gt;');
    expect(html).toContain('{"a":1}');
    expect(formatChartTooltip('<i>x</i>')).toBe('&lt;i&gt;x&lt;/i&gt;');
  });
});
