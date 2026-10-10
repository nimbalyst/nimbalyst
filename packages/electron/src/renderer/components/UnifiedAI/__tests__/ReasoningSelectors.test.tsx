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
  it('focuses effort by typeahead without selecting, and clears the query on reopening', () => {
    const onLevelChange = vi.fn();
    render(<EffortLevelSelector level="high" modelId="openai-codex/gpt-6-astra" onLevelChange={onLevelChange} />);
    const trigger = screen.getByTestId('effort-level-selector');
    fireEvent.click(trigger);
    for (const key of 'me') fireEvent.keyDown(document.activeElement!, { key });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Medium' }));
    expect(onLevelChange).not.toHaveBeenCalled();
    fireEvent.click(document.activeElement!);
    expect(onLevelChange).toHaveBeenCalledWith('medium');
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'l' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Low' }));
  });

  it.each([
    {
      name: 'effort',
      triggerLabel: 'Effort level: High',
      optionLabel: 'xHigh',
      optionRole: 'menuitemradio',
      renderSelector: () => <EffortLevelSelector level="high" modelId="openai-codex/gpt-6-astra" onLevelChange={vi.fn()} />,
    },
    {
      name: 'thinking',
      triggerLabel: 'Extended thinking: Extended: On',
      optionLabel: 'Extended: Off',
      optionRole: 'button',
      renderSelector: () => <ThinkingModeSelector mode="enabled" onModeChange={vi.fn()} />,
    },
  ])('portals the $name menu outside an overflow boundary', ({ triggerLabel, optionLabel, optionRole, renderSelector }) => {
    const { container } = render(
      <div data-testid="overflow-boundary" style={{ overflow: 'hidden' }}>
        {renderSelector()}
      </div>
    );

    fireEvent.click(screen.getByRole('button', { name: triggerLabel }));

    const option = screen.getByRole(optionRole, { name: optionLabel });
    const menu = option.closest('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
  });
});
