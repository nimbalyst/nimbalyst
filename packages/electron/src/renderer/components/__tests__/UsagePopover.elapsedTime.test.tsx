// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { ClaudeUsagePopover } from '../ClaudeUsageIndicator/ClaudeUsagePopover';
import { CodexUsagePopover } from '../CodexUsageIndicator/CodexUsagePopover';
import { GeminiUsagePopover } from '../GeminiUsageIndicator/GeminiUsagePopover';
import { claudeUsageAtom } from '../../store/atoms/claudeUsageAtoms';
import { codexUsageAtom } from '../../store/atoms/codexUsageAtoms';
import { geminiUsageAtom } from '../../store/atoms/geminiUsageAtoms';
import { limitRatio, formatLimitRatio } from '../limitRatio';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('../../hooks/useFloatingMenu', () => ({
  useFloatingMenu: () => ({ refs: { setReference: () => {}, setFloating: () => {} }, floatingStyles: {}, getFloatingProps: () => ({}) }),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  return { toggleGutterItemHiddenAtom: atom(null, () => {}) };
});
vi.mock('../UsageHistory/WeeklyUsageHistory', () => ({ WeeklyUsageHistory: () => null }));

const fixedNow = new Date('2026-11-16T00:00:00.000Z');
const fiveHours = 5 * 60 * 60 * 1000;
const sevenDays = 7 * 24 * 60 * 60 * 1000;
const anchorRef = { current: null };
const popoverProps = { anchorRef, onClose: () => {}, onRefresh: async () => {} };

beforeEach(() => vi.useFakeTimers({ now: fixedNow }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

function expectWindowElapsed(root: Element | null, percent: number) {
  expect(root?.textContent).toContain(`[${percent}% passed]`);
  expect(root?.querySelector(`[title="${percent}% of window elapsed"]`)).not.toBeNull();
}

it('calculates the historical ratio without rounding inputs and handles invalid values', () => {
  expect(limitRatio(30, 10)).toBe(3);
  expect(limitRatio(49.6, 20)).toBe(2.48);
  expect(formatLimitRatio(limitRatio(49.6, 20))).toBe('2.5×');
  expect(formatLimitRatio(limitRatio(30, 0))).toBe('∞');
  expect(limitRatio(0, 0)).toBeNull();
  expect(limitRatio(0, 20)).toBe(0);
  for (const bad of [-1, NaN, Infinity]) expect(limitRatio(30, bad)).toBeNull();
  expect(limitRatio(null, 10)).toBeNull();
});

describe('usage popover elapsed time', () => {
  it('shows elapsed text for every rendered Claude window', () => {
    const store = createStore();
    const reset = new Date(fixedNow.getTime() + fiveHours * 0.51).toISOString();
    store.set(claudeUsageAtom, {
      fiveHour: { utilization: 20, resetsAt: reset },
      sevenDay: { utilization: 20, resetsAt: new Date(fixedNow.getTime() + sevenDays * 0.51).toISOString() },
      weeklyModelLimits: [{ model: 'Fable', utilization: 20, resetsAt: new Date(fixedNow.getTime() + sevenDays * 0.51).toISOString() }],
      sevenDayOpus: { utilization: 20, resetsAt: new Date(fixedNow.getTime() + sevenDays * 0.51).toISOString() },
      lastUpdated: fixedNow.getTime(),
    } as never);
    render(<Provider store={store}><ClaudeUsagePopover {...popoverProps} /></Provider>);
    for (const heading of ['Session', 'Weekly', 'Fable (Weekly)', 'Opus (Weekly)']) {
      expectWindowElapsed(screen.getByText(heading).closest('.claude-usage-section'), 49);
      expect(screen.getByText(heading).closest('.claude-usage-section')?.textContent).toContain('Limit ratio: 2.5×');
    }
  });

  it('covers Codex valid zero, rounding, and missing or invalid duration/reset timing', () => {
    const store = createStore();
    store.set(codexUsageAtom, {
      limits: [{ id: 'account', name: 'Account', planType: null, credits: {}, windows: [
        { slot: 'primary', usedPercent: 20, windowDurationMins: 300, resetsAt: new Date(fixedNow.getTime() + fiveHours).toISOString() },
        { slot: 'secondary', usedPercent: 20, windowDurationMins: 300, resetsAt: new Date(fixedNow.getTime() + fiveHours * 0.504).toISOString() },
      ] }, { id: 'unknown', name: 'Unknown', planType: null, credits: {}, windows: [
        { slot: 'primary', usedPercent: 20, windowDurationMins: null, resetsAt: new Date(fixedNow.getTime() + fiveHours * 0.51).toISOString() },
        { slot: 'secondary', usedPercent: 20, windowDurationMins: 300, resetsAt: 'not-a-date' },
      ] }],
    } as never);
    render(<Provider store={store}><CodexUsagePopover {...popoverProps} /></Provider>);
    const sections = [...document.querySelectorAll('.codex-usage-section')];
    expectWindowElapsed(sections[0], 0);
    expectWindowElapsed(sections[1], 50);
    expect(sections[0].textContent).toContain('Limit ratio: 0.0×');
    expect(sections[1].textContent).toContain('Limit ratio: 2.5×');
    for (const section of sections.slice(2)) {
      expect(section.textContent).not.toMatch(/passed/);
      expect(section.textContent).toContain('Limit ratio: unavailable');
      expect(section.querySelector('[title$="of window elapsed"]')).toBeNull();
    }
  });

  it('shows no elapsed percentage or limit ratio for Gemini, whose quota durations are unknown', () => {
    const store = createStore();
    store.set(geminiUsageAtom, {
      fiveHour: { utilization: 20, resetsAt: new Date(fixedNow.getTime() + fiveHours * 0.51).toISOString() },
      sevenDay: { utilization: 20, resetsAt: new Date(fixedNow.getTime() + sevenDays * 0.51).toISOString() },
      lastUpdated: fixedNow.getTime(), notStarted: false,
    } as never);
    render(<Provider store={store}><GeminiUsagePopover {...popoverProps} /></Provider>);
    for (const heading of ['Session', 'Secondary']) {
      const section = screen.getByText(heading).closest('.gemini-usage-section');
      expect(section?.textContent).toContain('Resets in');
      expect(section?.textContent).not.toMatch(/passed|Limit ratio/);
    }
  });

  it('clamps elapsed time at both reset boundaries and omits invalid reset data', () => {
    const store = createStore();
    store.set(claudeUsageAtom, {
      fiveHour: { utilization: 20, resetsAt: new Date(fixedNow.getTime() + fiveHours).toISOString() },
      sevenDay: { utilization: 20, resetsAt: new Date(fixedNow.getTime() - 1).toISOString() },
      weeklyModelLimits: [{ model: 'Invalid', utilization: 20, resetsAt: 'not-a-date' }],
      lastUpdated: fixedNow.getTime(),
    } as never);
    render(<Provider store={store}><ClaudeUsagePopover {...popoverProps} /></Provider>);
    const sections = document.querySelectorAll('.claude-usage-section');
    expectWindowElapsed(sections[0], 0);
    // An expired window shows "Resets in Now" with no elapsed suffix or ratio line.
    expect(sections[1].textContent).toContain('Resets in Now');
    expect(sections[1].textContent).not.toMatch(/passed/);
    expect(sections[1].textContent).not.toMatch(/Limit ratio/);
    const invalid = screen.getByText('Invalid (Weekly)').closest('.claude-usage-section');
    expect(invalid?.querySelector('[title$="of window elapsed"]')).toBeNull();
    expect(invalid?.textContent).not.toMatch(/passed/);
  });
});
