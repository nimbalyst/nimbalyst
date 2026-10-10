// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OllamaUsagePopover } from '../OllamaUsagePopover';
import { ollamaUsageAtom } from '../../../store/atoms/ollamaUsageAtoms';
import { loadOllamaResetTimes } from '../../../store/listeners/ollamaUsageListeners';

const h = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../../shared/ollamaResetWindows', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../shared/ollamaResetWindows')>(),
  get OLLAMA_RESET_SCRAPE_ENABLED() { return h.enabled; },
}));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('../../../store/listeners/ollamaUsageListeners', () => ({ loadOllamaResetTimes: vi.fn() }));
vi.mock('../../../hooks/useFloatingMenu', () => ({
  useFloatingMenu: () => ({ refs: { setReference() {}, setFloating() {} }, floatingStyles: {}, getFloatingProps: () => ({}) }),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
beforeEach(() => { h.enabled = true; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T12:00:00Z')); vi.mocked(loadOllamaResetTimes).mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function panel(overrides: any = {}, onRefresh: () => Promise<void> = async () => {}) {
  const store = createStore();
  store.set(ollamaUsageAtom, {
    limitsAvailable: true, lastUpdated: Date.now(),
    session: { utilization: 70, models: [], resetsAt: '2026-10-06T14:30:00Z', windowStart: '2026-10-06T09:30:00Z', windowEnd: '2026-10-06T14:30:00Z' },
    weekly: { utilization: 40, models: [], resetsAt: '2026-10-10T00:00:00Z', windowStart: '2026-10-03T00:00:00Z', windowEnd: '2026-10-10T00:00:00Z' },
    ...overrides,
  });
  return render(<Provider store={store}><OllamaUsagePopover anchorRef={{ current: null }} onClose={() => {}} onRefresh={onRefresh} /></Provider>);
}

it('[enabled scrape] places each window marker at provider-bounded elapsed time and updates its countdown while open', () => {
  const { container } = panel();
  const markers = container.querySelectorAll('[title$="of window elapsed"]');
  expect(Array.from(markers, m => (m as HTMLElement).style.left)).toEqual(['50%', '50%']);
  screen.getByText('Resets in 2h 30m');
  act(() => { vi.advanceTimersByTime(60_000); });
  screen.getByText('Resets in 2h 29m');
  expect(Number.parseFloat((markers[0] as HTMLElement).style.left)).toBeGreaterThan(50);
});

it.each([null, 'tomorrow-ish', '2026-10-06T11:00:00Z'])('[enabled scrape] hides an unknown, malformed, or ended reset (%s)', reset => {
  const { container } = panel({ session: { utilization: 70, models: [], resetsAt: reset, windowStart: '2026-10-06T09:30:00Z', windowEnd: reset }, weekly: undefined });
  expect(container.querySelector('[title$="of window elapsed"]')).toBeNull();
  expect(screen.queryByText(/Resets in/)).toBeNull();
  screen.getByText('Reset time unavailable');
});

it.each([
  ['session', '2026-10-06T14:30:00Z', '5-hour'],
  ['weekly', '2026-10-10T00:00:00Z', '7-day'],
])('[enabled scrape] uses and labels the nominal length for an end-only %s window', (kind, resetsAt, label) => {
  const { container } = panel({ session: undefined, weekly: undefined, [kind]: { utilization: 70, models: [], resetsAt } });
  const marker = screen.getByTitle(`About 50% of the nominal ${label} window elapsed`);
  expect(marker.style.left).toBe('50%');
  expect(container.querySelectorAll('[title*="window elapsed"]')).toHaveLength(1);
  expect(screen.getByText(/Resets in/)).toBeDefined();
});

it('[enabled scrape] uses provider duration instead of the nominal length and labels it without approximation', () => {
  panel({ session: { utilization: 70, models: [], resetsAt: '2026-10-06T14:30:00Z', windowStart: '2026-10-06T11:30:00Z', windowEnd: '2026-10-06T14:30:00Z', durationSource: 'provider' }, weekly: undefined });
  const marker = screen.getByTitle('17% of window elapsed');
  expect(Number.parseFloat(marker.style.left)).toBeCloseTo(100 / 6);
});

it('[enabled scrape] does not turn rejected provider bounds into a nominal marker', () => {
  const { container } = panel({ session: { utilization: 70, models: [], resetsAt: '2026-10-06T14:30:00Z', windowStart: null, windowEnd: '2026-10-06T14:30:00Z', durationSource: 'provider' }, weekly: undefined });
  expect(container.querySelector('[title*="window elapsed"]')).toBeNull();
  screen.getByText('Resets in 2h 30m');
});

it('[enabled scrape] preserves usage and the API cost period when the cookie expires, with no quota markers', () => {
  const { container } = panel({ cookieExpired: true, resetTimeStatus: 'cookie-expired', costUSD: 1.25,
    costPeriod: { type: 'last_4_weeks', startingAt: '2026-10-01T00:00:00Z', endingAt: '2026-10-29T00:00:00Z' } });
  screen.getByText(/session cookie expired/i);
  screen.getByText('70%');
  screen.getByText('Cost Period');
  expect(container.querySelector('[title$="of window elapsed"]')).toBeNull();
});

it('[enabled scrape] shows a startup retry wait for unreadable reset storage while preserving percentage bars', () => {
  const { container } = panel({ resetTimeStatus: 'error', resetTimeRetryAt: Date.now() + 5 * 60_000 });
  screen.getByText(/Waiting after startup; retry in about 5 minutes/);
  screen.getByText('70%');
  expect(container.querySelector('[title*="window elapsed"]')).toBeNull();
  act(() => { vi.advanceTimersByTime(60_000); });
  screen.getByText(/retry in about 4 minutes/);
});

it('[enabled scrape] requests once on open and once at a known boundary; clock repaint never polls the network', () => {
  const { unmount } = panel();
  expect(loadOllamaResetTimes).toHaveBeenCalledOnce();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(loadOllamaResetTimes).toHaveBeenCalledOnce();
  act(() => { vi.advanceTimersByTime(149 * 60_000 + 20); });
  expect(loadOllamaResetTimes).toHaveBeenCalledTimes(2);
  unmount(); act(() => { vi.advanceTimersByTime(7 * 24 * 60 * 60_000); });
  expect(loadOllamaResetTimes).toHaveBeenCalledTimes(2);
});


it.each(['ok', 'error', 'cookie-expired'])('shows percentage bars and cost with no reset UI, error banner or reset timers when disabled (%s)', async status => {
  h.enabled = false;
  const refreshUsage = vi.fn().mockResolvedValue(undefined);
  const { container } = panel({ resetTimeStatus: status, cookieExpired: true, resetTimeRetryAt: Date.now() + 300_000,
    costUSD: 1.25, costPeriod: { type: 'last_4_weeks', startingAt: '2026-10-01T00:00:00Z', endingAt: '2026-10-29T00:00:00Z' } }, refreshUsage);
  screen.getByText('70%'); screen.getByText('40%'); screen.getByText('Cost Period');
  expect(container.querySelector('[title*="window elapsed"]')).toBeNull();
  expect(screen.queryByText(/Resets in|Reset time unavailable|cookie expired|Waiting after startup/i)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { fireEvent.click(screen.getByLabelText('Refresh usage')); });
  expect(refreshUsage).toHaveBeenCalledOnce();
  act(() => { vi.advanceTimersByTime(7 * 24 * 60 * 60_000); });
  expect(loadOllamaResetTimes).not.toHaveBeenCalled();
});
