// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CatalogControlSelectors } from '../CatalogControlSelectors';

describe('CatalogControlSelectors', () => {
  it('renders only controls declared for the selected model and emits semantic settings', () => {
    const onChange = vi.fn();
    render(
      <CatalogControlSelectors
        modelId="claude-code:opus"
        values={{ 'effort-level': 'high', 'thinking-mode': 'enabled' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByLabelText('Reasoning effort')).toBeTruthy();
    expect(screen.getByLabelText('Extended thinking')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'max' } });
    expect(onChange).toHaveBeenCalledWith('effort-level', 'max');
  });

  it('renders no inferred controls for an unknown model', () => {
    const { container } = render(
      <CatalogControlSelectors modelId="model-launcher:other" values={{}} onChange={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the reviewed default when persisted input is stale', () => {
    render(
      <CatalogControlSelectors
        modelId="model-launcher:deepseek-pro"
        values={{ 'effort-level': 'unsupported' }}
        onChange={vi.fn()}
      />,
    );

    expect((screen.getByLabelText('Reasoning effort') as HTMLSelectElement).value).toBe('high');
  });
});
