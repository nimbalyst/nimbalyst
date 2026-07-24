import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelHideButton } from '../components/PanelHideButton';

describe('PanelHideButton', () => {
  it('asks the panel host to hide the panel', () => {
    const onHide = vi.fn();
    render(<PanelHideButton onHide={onHide} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide Git panel' }));

    expect(onHide).toHaveBeenCalledOnce();
  });
});
