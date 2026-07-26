// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

// Keep the component isolated: jotai atom reads return defaults, and the store
// atom families are callable stubs so importing them has no side effects.
vi.mock('jotai', () => ({
  useAtomValue: () => undefined,
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null, ProviderIcon: () => null }));
// The store atoms are callable stubs (atom families called with a sessionId);
// their values are read through the mocked jotai useAtomValue above, so the
// stub return value never matters. Factories are inlined (no outer ref) to
// avoid the vi.mock hoisting TDZ.
vi.mock('../../../store', () => ({
  sessionOrChildProcessingAtom: () => ({}),
  sessionUnreadAtom: () => ({}),
  sessionPendingPromptAtom: () => ({}),
  sessionHasPendingInteractivePromptAtom: () => ({}),
  reparentSessionAtom: () => ({}),
  refreshSessionListAtom: () => ({}),
  sessionShareAtom: () => ({}),
  sessionWakeupAtom: () => ({}),
  sessionLastActivityAtom: () => ({}),
}));
vi.mock('../../../store/atoms/sessions', () => ({ convertToWorkstreamAtom: () => ({}) }));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));

import { SessionListItem } from '../SessionListItem';

const baseProps = {
  id: 's1',
  createdAt: 1_700_000_000_000,
  isActive: false,
  onClick: () => {},
};

const setElementWidth = (element: Element, { clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number }) => {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        x: 40,
        y: 80,
        top: 80,
        right: 200,
        bottom: 100,
        left: 40,
        width: 160,
        height: 20,
        toJSON: () => {},
      }),
    },
  });
};

afterEach(() => cleanup());

describe('SessionListItem - full name on hover (#577, #429)', () => {
  it('expands the clipped title from the rendered title position', async () => {
    const long = 'A very long session name that runs well past the forty character cutoff';
    const { container } = render(<SessionListItem {...baseProps} title={long} />);
    const titleEl = container.querySelector('.session-list-item-title')!;
    setElementWidth(titleEl, { clientWidth: 160, scrollWidth: 320 });
    fireEvent.mouseEnter(titleEl);

    const tooltip = screen.getByRole('tooltip');
    expect(titleEl.getAttribute('title')).toBeNull();
    expect(tooltip.textContent).toBe(long);
    expect(tooltip.className).toContain('whitespace-pre-wrap');
    expect(tooltip.className).toContain('break-all');
    expect(tooltip.className).toContain('px-1.5');
    expect(tooltip.className).toContain('py-0.5');
    expect(tooltip.className).not.toContain('var(--nim-border)');
    await waitFor(() => {
      expect(tooltip.style.transform).toBe('translate(34px, 78px)');
    });
  });

  it('does not show a tooltip when the full title fits', () => {
    const short = 'Short name';
    const { container } = render(<SessionListItem {...baseProps} title={short} />);
    const titleEl = container.querySelector('.session-list-item-title')!;
    setElementWidth(titleEl, { clientWidth: 160, scrollWidth: 80 });
    fireEvent.mouseEnter(titleEl);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  // The native title is not a keyboard/touch affordance, so the row's
  // accessible name must carry the full (untruncated) title too, or two
  // sessions sharing the first 40 chars are indistinguishable to a screen reader.
  it('uses the full name in the row aria-label, not the truncated form', () => {
    const long = 'A very long session name that runs well past the forty character cutoff';
    const { container } = render(<SessionListItem {...baseProps} title={long} />);
    const row = container.querySelector('[aria-label^="Session: "]');
    expect(row?.getAttribute('aria-label')).toContain(long);
  });
});
