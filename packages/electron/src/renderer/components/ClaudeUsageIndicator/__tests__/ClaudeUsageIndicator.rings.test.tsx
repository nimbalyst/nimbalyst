import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeUsageIndicator } from '../ClaudeUsageIndicator';
import { claudeUsageAtom, type ClaudeUsageData } from '../../../store/atoms/claudeUsageAtoms';

vi.mock('../ClaudeUsagePopover', () => ({ ClaudeUsagePopover: () => null }));
vi.mock('../../../store/listeners/claudeUsageListeners', () => ({
  refreshClaudeUsage: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

const usage: ClaudeUsageData = {
  fiveHour: { utilization: 25, resetsAt: '2026-09-13T12:00:00Z' },
  sevenDay: { utilization: 50, resetsAt: '2026-09-19T12:00:00Z' },
  scopedLimits: [
    {
      id: 'weekly_scoped:fable:0',
      label: 'Fable',
      utilization: 75,
      resetsAt: '2026-09-19T12:00:00Z',
      severity: 'warning',
    },
    {
      id: 'weekly_scoped:opus:1',
      label: 'Opus',
      utilization: 10,
      resetsAt: '2026-09-19T12:00:00Z',
      severity: 'normal',
    },
  ],
  lastUpdated: Date.now(),
};

function renderIndicator(value: ClaudeUsageData = usage) {
  const store = createStore();
  store.set(claudeUsageAtom, value);
  return render(
    <Provider store={store}>
      <ClaudeUsageIndicator />
    </Provider>
  );
}

describe('ClaudeUsageIndicator concentric rings', () => {
  it('renders panel order from outer to inner', () => {
    const { getByTestId } = renderIndicator();
    const rings = [
      getByTestId('claude-usage-ring-session'),
      getByTestId('claude-usage-ring-weekly'),
      getByTestId('claude-usage-ring-weekly_scoped:fable:0'),
      getByTestId('claude-usage-ring-weekly_scoped:opus:1'),
    ];

    expect(rings.map((ring) => ring.getAttribute('data-usage-label'))).toEqual([
      'Session',
      'Weekly',
      'Fable (Weekly)',
      'Opus (Weekly)',
    ]);
    const radii = rings.map((ring) => Number(ring.getAttribute('r')));
    expect(radii[0]).toBe(12);
    expect(radii.at(-1)).toBe(8);
    expect(radii.every((radius, index) => index === 0 || radius < radii[index - 1])).toBe(true);
  });

  it('uses distinct colors and each ring\'s own utilization', () => {
    const { getByTestId } = renderIndicator();
    const session = getByTestId('claude-usage-ring-session');
    const weekly = getByTestId('claude-usage-ring-weekly');
    const fable = getByTestId('claude-usage-ring-weekly_scoped:fable:0');

    expect(session.getAttribute('class')).toContain('stroke-green-500');
    expect(weekly.getAttribute('class')).toContain('stroke-blue-500');
    expect(fable.getAttribute('class')).toContain('stroke-purple-500');

    for (const [ring, utilization] of [[session, 25], [weekly, 50], [fable, 75]] as const) {
      const circumference = Number(ring.getAttribute('stroke-dasharray'));
      expect(Number(ring.getAttribute('stroke-dashoffset'))).toBeCloseTo(
        circumference * (1 - utilization / 100)
      );
    }
  });

  it('summarizes every ring in the hover text in the same order', () => {
    const { getByTestId } = renderIndicator();
    const title = getByTestId('claude-usage-indicator').getAttribute('title') ?? '';

    expect(title.indexOf('Session: 25%')).toBeLessThan(title.indexOf('Weekly: 50%'));
    expect(title.indexOf('Weekly: 50%')).toBeLessThan(title.indexOf('Fable (Weekly): 75%'));
    expect(title.indexOf('Fable (Weekly): 75%')).toBeLessThan(title.indexOf('Opus (Weekly): 10%'));
  });

  it('shrinks additional bands instead of letting adjacent rings overlap', () => {
    const scopedLimits = Array.from({ length: 8 }, (_, index) => ({
      id: `weekly_scoped:model-${index}:${index}`,
      label: `Model ${index}`,
      utilization: index + 1,
      resetsAt: null,
      severity: 'normal' as const,
    }));
    const { container } = renderIndicator({ ...usage, scopedLimits });
    const rings = Array.from(container.querySelectorAll<SVGCircleElement>('[data-usage-label]'));

    expect(rings).toHaveLength(10);
    for (let index = 1; index < rings.length; index += 1) {
      const previousRadius = Number(rings[index - 1].getAttribute('r'));
      const radius = Number(rings[index].getAttribute('r'));
      const strokeWidth = Number(rings[index].getAttribute('stroke-width'));
      expect(previousRadius - radius).toBeGreaterThan(strokeWidth);
    }
  });
});
