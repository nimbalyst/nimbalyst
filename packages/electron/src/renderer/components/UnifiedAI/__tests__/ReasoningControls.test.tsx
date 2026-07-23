// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHelpContent } from '../../../help/HelpContent';
import { EffortLevelSelector } from '../EffortLevelSelector';
import { ThinkingModeSelector } from '../ThinkingModeSelector';

describe('model reasoning controls', () => {
  afterEach(cleanup);

  it('renders only the effort values supported by the selected model', () => {
    render(
      <EffortLevelSelector
        level="high"
        onLevelChange={vi.fn()}
        levels={[
          { key: 'low', label: 'Low' },
          { key: 'medium', label: 'Medium' },
          { key: 'high', label: 'High' },
          { key: 'max', label: 'Max' },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId('effort-level-selector'));

    expect(screen.getByRole('button', { name: 'Max' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Extra High' })).toBeNull();
  });

  it('labels adaptive thinking without calling it extended thinking', () => {
    render(<ThinkingModeSelector mode="enabled" onModeChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Thinking: Adaptive' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('thinking-mode-selector'));
    expect(screen.getByRole('button', { name: 'Thinking: Off' })).toBeTruthy();
    expect(screen.queryByText(/extended/i)).toBeNull();
  });

  it('defines each exposed degree of freedom in the help registry', () => {
    expect(getHelpContent('effort-level-selector')).toMatchObject({
      title: 'Reasoning Effort',
      body: expect.stringMatching(/reasoning depth and response work/i),
    });
    expect(getHelpContent('thinking-mode-selector')).toMatchObject({
      title: 'Adaptive Thinking',
      body: expect.stringMatching(/does not change context size/i),
    });
  });
});
