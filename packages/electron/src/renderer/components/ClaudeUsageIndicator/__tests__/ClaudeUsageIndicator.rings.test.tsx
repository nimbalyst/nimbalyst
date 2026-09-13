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
  sevenDayOpus: { utilization: 75, resetsAt: '2026-09-19T12:00:00Z' },
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

describe('ClaudeUsageIndicator nested rings', () => {
  it('enlarges the session ring and orders panel limits from outer to inner', () => {
    const { getByTestId } = renderIndicator();
    const rings = [
      getByTestId('claude-usage-ring-session'),
      getByTestId('claude-usage-ring-weekly'),
      getByTestId('claude-usage-ring-opus-weekly'),
    ];

    expect(rings.map((ring) => ring.getAttribute('data-usage-label'))).toEqual([
      'Session',
      'Weekly',
      'Opus (Weekly)',
    ]);

    const radii = rings.map((ring) => Number(ring.getAttribute('r')));
    expect(radii[0]).toBe(14);
    expect(radii[0]).toBeGreaterThan(12);
    expect(radii[1]).toBeLessThan(radii[0]);
    expect(radii[2]).toBeLessThan(radii[1]);
  });

  it('uses distinct colors and each ring\'s own utilization', () => {
    const { getByTestId } = renderIndicator();
    const session = getByTestId('claude-usage-ring-session');
    const weekly = getByTestId('claude-usage-ring-weekly');
    const opus = getByTestId('claude-usage-ring-opus-weekly');

    expect(session.getAttribute('class')).toContain('stroke-green-500');
    expect(weekly.getAttribute('class')).toContain('stroke-blue-500');
    expect(opus.getAttribute('class')).toContain('stroke-purple-500');

    for (const [ring, ringUtilization] of [[session, 25], [weekly, 50], [opus, 75]] as const) {
      const circumference = Number(ring.getAttribute('stroke-dasharray'));
      expect(Number(ring.getAttribute('stroke-dashoffset'))).toBeCloseTo(
        circumference * (1 - ringUtilization / 100)
      );
    }
  });

  it('omits an unavailable optional ring and summarizes visible rings on hover', () => {
    const { getByTestId, queryByTestId } = renderIndicator({
      ...usage,
      sevenDayOpus: undefined,
    });
    const title = getByTestId('claude-usage-indicator').getAttribute('title') ?? '';

    expect(queryByTestId('claude-usage-ring-opus-weekly')).toBeNull();
    expect(title.indexOf('Session: 25%')).toBeLessThan(title.indexOf('Weekly: 50%'));
    expect(title).not.toContain('Opus');
  });

  it('keeps every ring inside the 32px meter without overlap', () => {
    const { container } = renderIndicator();
    const rings = Array.from(container.querySelectorAll<SVGCircleElement>('[data-usage-label]'));

    for (const ring of rings) {
      const radius = Number(ring.getAttribute('r'));
      const strokeWidth = Number(ring.getAttribute('stroke-width'));
      expect(radius + strokeWidth / 2).toBeLessThanOrEqual(16);
    }

    for (let index = 1; index < rings.length; index += 1) {
      const previousRadius = Number(rings[index - 1].getAttribute('r'));
      const radius = Number(rings[index].getAttribute('r'));
      const previousStrokeWidth = Number(rings[index - 1].getAttribute('stroke-width'));
      const strokeWidth = Number(rings[index].getAttribute('stroke-width'));
      expect(previousRadius - radius).toBeGreaterThanOrEqual(
        (previousStrokeWidth + strokeWidth) / 2
      );
    }
  });
});
