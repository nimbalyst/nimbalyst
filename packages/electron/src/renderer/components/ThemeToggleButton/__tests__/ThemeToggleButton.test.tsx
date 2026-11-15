// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../hooks/useTheme', () => ({
  getAllAvailableThemesAsync: vi.fn().mockResolvedValue([{ id: 'dark', name: 'Dark', isDark: true }]),
}));

import { ThemeToggleButton } from '../ThemeToggleButton';

afterEach(cleanup);

describe('ThemeToggleButton', () => {
  // The button lives in the project rail, whose container clips overflow.
  it('renders the theme menu outside the clipping rail container', async () => {
    const { container } = render(
      <Provider store={createStore()}><div style={{ overflow: 'hidden' }}><ThemeToggleButton /></div></Provider>,
    );
    fireEvent.click(screen.getByTestId('gutter-theme-button'));
    await screen.findByText('Dark');
    expect(container.contains(screen.getByRole('menu'))).toBe(false);
  });
});
