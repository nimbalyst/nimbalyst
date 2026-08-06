// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UnifiedOnboarding } from '../UnifiedOnboarding';

describe('UnifiedOnboarding completion intent', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it.each([
    ['Get started…', 'get-started'],
    ['Start tutorial', 'tutorial'],
  ] as const)('passes the %s intent through onComplete', (buttonName, intent) => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      invoke: vi.fn().mockResolvedValue({}),
    };
    const onComplete = vi.fn();

    render(
      <UnifiedOnboarding
        isOpen
        onComplete={onComplete}
        onSkip={() => {}}
        forcedMode="new"
      />,
    );

    fireEvent.click(screen.getByText('Standard Mode'));
    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ developerMode: false }),
      intent,
    );
  });
});
