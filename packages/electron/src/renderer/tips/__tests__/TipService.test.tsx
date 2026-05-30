// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { WalkthroughState } from '../../walkthroughs/types';
import type { TipDefinition } from '../types';
import { shouldShowTip } from '../TipService';
import { TipCard } from '../TipCard';

const baseState: WalkthroughState = {
  enabled: true,
  completed: [],
  dismissed: [],
  history: {},
};

const baseTip: TipDefinition = {
  id: 'tip-test',
  name: 'Test Tip',
  version: 2,
  trigger: {
    condition: () => true,
  },
  content: {
    title: 'Test Tip',
    body: 'Body',
  },
};

describe('shouldShowTip', () => {
  it('does not show completed tips on the same version', () => {
    const state: WalkthroughState = {
      ...baseState,
      completed: ['tip-test'],
      history: {
        'tip-test': {
          shownAt: 1,
          completedAt: 2,
          version: 2,
        },
      },
    };

    expect(shouldShowTip(state, baseTip)).toBe(false);
  });

  it('re-shows a completed tip when the version changes', () => {
    const state: WalkthroughState = {
      ...baseState,
      completed: ['tip-test'],
      dismissed: ['tip-test'],
      history: {
        'tip-test': {
          shownAt: 1,
          completedAt: 2,
          dismissedAt: 3,
          version: 1,
        },
      },
    };

    expect(shouldShowTip(state, baseTip)).toBe(true);
  });
});

describe('TipCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders paragraphs, bullet lists, and bold text in the body', () => {
    const tip: TipDefinition = {
      ...baseTip,
      content: {
        title: 'Formatting Tip',
        body: 'Lead paragraph with **bold** text.\n\n- First item\n- Second **item**',
        action: {
          label: 'Do it',
          onClick: vi.fn(),
        },
      },
    };

    render(
      <TipCard
        tip={tip}
        onDismiss={vi.fn()}
        onAction={vi.fn()}
      />
    );

    expect(screen.getByText('Formatting Tip')).toBeTruthy();

    const list = screen.getByRole('list');
    expect(list).toBeTruthy();

    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['First item', 'Second item']);

    const paragraph = document.querySelector('.tip-card-paragraph');
    expect(paragraph?.textContent).toBe('Lead paragraph with bold text.');
  });
});
