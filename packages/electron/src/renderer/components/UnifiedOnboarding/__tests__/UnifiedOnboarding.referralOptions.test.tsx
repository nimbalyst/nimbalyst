// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { UnifiedOnboarding } from '../UnifiedOnboarding';

const NEW_REFERRAL_OPTIONS = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'github', label: 'GitHub' },
  { value: 'course_training', label: 'Course/Training' },
  { value: 'podcast', label: 'Podcast' },
  { value: 'newsletter_article', label: 'Newsletter/Article' },
];

describe('UnifiedOnboarding referral options', () => {
  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it('shows and submits each discovery source', () => {
    (window as any).electronAPI = {
      invoke: vi.fn().mockResolvedValue({}),
    };
    const onComplete = vi.fn();

    render(
      <UnifiedOnboarding
        isOpen={true}
        onComplete={onComplete}
        onSkip={() => {}}
        forcedMode="new"
      />,
    );

    fireEvent.click(screen.getByText('Standard Mode'));
    const referralSelect = screen.getByLabelText('How did you hear about Nimbalyst?');

    for (const option of NEW_REFERRAL_OPTIONS) {
      const renderedOption = within(referralSelect).getByRole('option', { name: option.label });
      expect((renderedOption as HTMLOptionElement).value).toBe(option.value);
      fireEvent.change(referralSelect, { target: { value: option.value } });
      fireEvent.click(screen.getByRole('button', { name: 'Get Started' }));
      expect(onComplete).toHaveBeenLastCalledWith(
        expect.objectContaining({ referralSource: option.value }),
      );
    }
  });

  it('asks what the user searched for and submits the detail', () => {
    (window as any).electronAPI = {
      invoke: vi.fn().mockResolvedValue({}),
    };
    const onComplete = vi.fn();

    render(
      <UnifiedOnboarding
        isOpen={true}
        onComplete={onComplete}
        onSkip={() => {}}
        forcedMode="new"
      />,
    );

    fireEvent.click(screen.getByText('Standard Mode'));
    fireEvent.change(screen.getByLabelText('How did you hear about Nimbalyst?'), {
      target: { value: 'search' },
    });
    fireEvent.change(screen.getByLabelText('What did you search for?'), {
      target: { value: 'AI code editor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Get Started' }));

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ referralSource: 'search:AI code editor' }),
    );
  });
});
