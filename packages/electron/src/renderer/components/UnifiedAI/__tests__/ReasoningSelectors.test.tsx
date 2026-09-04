// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EffortLevelSelector } from '../EffortLevelSelector';
import { ThinkingModeSelector } from '../ThinkingModeSelector';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => null,
}));

afterEach(() => cleanup());

describe('reasoning selector menu positioning', () => {
  it.each([
    {
      name: 'effort',
      triggerLabel: 'Effort level: High',
      optionLabel: 'xHigh',
      renderSelector: () => <EffortLevelSelector level="high" modelId="openai-codex/gpt-6-astra" onLevelChange={vi.fn()} />,
    },
    {
      name: 'thinking',
      triggerLabel: 'Extended thinking: Extended: On',
      optionLabel: 'Extended: Off',
      renderSelector: () => <ThinkingModeSelector mode="enabled" onModeChange={vi.fn()} />,
    },
  ])('portals the $name menu outside an overflow boundary', ({ triggerLabel, optionLabel, renderSelector }) => {
    const { container } = render(
      <div data-testid="overflow-boundary" style={{ overflow: 'hidden' }}>
        {renderSelector()}
      </div>
    );

    fireEvent.click(screen.getByRole('button', { name: triggerLabel }));

    const option = screen.getByRole('button', { name: optionLabel });
    const menu = option.closest('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
  });
});
