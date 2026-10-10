import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../store/atoms/ollamaUsageAtoms', () => ({ formatResetTime: () => '1h' }));
import { CostPeriodSection } from '../CostPeriodSection';
const period = { type: 'billing', startingAt: '2026-09-10T00:00:00Z', endingAt: '2026-09-10T02:00:00Z' };
const render = (p = period) => renderToStaticMarkup(<CostPeriodSection costPeriod={p} costUSD={0.12345} />);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-10T01:00:00Z')); });
afterEach(() => vi.useRealTimers());
describe('CostPeriodSection', () => {
  it('uses the API bounds for elapsed time and preserves metered cost', () => {
    const html = render(); expect(html).toContain('aria-valuenow="50"'); expect(html).toContain('$0.12345');
    expect(html).toContain('Cost period ends in 1h'); expect(html).not.toContain('Resets');
  });
  it('recomputes elapsed on a later render with the same bounds', () => {
    render(); vi.setSystemTime(new Date('2026-09-10T01:30:00Z')); expect(render()).toContain('aria-valuenow="75"');
  });
  it('clamps future periods to zero', () => {
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z')); expect(render()).toContain('aria-valuenow="0"');
  });
  it('labels ended cost periods without claiming quota reset', () => {
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z')); const html = render();
    expect(html).toContain('aria-valuenow="100"'); expect(html).toContain('Cost period ended'); expect(html).not.toContain('ends in');
  });
  it.each(['invalid', '2026-09-10T02:00:00Z', '2026-09-11T00:00:00Z'])('omits a false elapsed gauge for invalid bounds %s', startingAt => {
    const html = render({ ...period, startingAt }); expect(html).not.toContain('progressbar'); expect(html).not.toContain('ends in'); expect(html).toContain('$0.12345');
  });
});
