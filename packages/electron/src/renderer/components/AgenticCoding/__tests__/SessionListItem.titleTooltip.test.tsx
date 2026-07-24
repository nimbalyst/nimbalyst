// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

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

afterEach(() => cleanup());

describe('SessionListItem - full name on hover (#577, #429)', () => {
  it('wraps the full name in an in-app tooltip for a long, JS-truncated name', () => {
    const long = 'A very long session name that runs well past the forty character cutoff';
    const { container } = render(<SessionListItem {...baseProps} title={long} />);
    const titleEl = container.querySelector('.session-list-item-title');
    fireEvent.mouseEnter(titleEl!);

    const tooltip = screen.getByRole('tooltip');
    expect(titleEl?.getAttribute('title')).toBeNull();
    expect(tooltip.textContent).toBe(long);
    expect(tooltip.className).toContain('whitespace-pre-wrap');
    expect(tooltip.className).toContain('break-all');
  });

  it('uses the same full-name tooltip for a short name that CSS could clip in a narrow pane', () => {
    const short = 'Short name';
    const { container } = render(<SessionListItem {...baseProps} title={short} />);
    const titleEl = container.querySelector('.session-list-item-title');
    fireEvent.mouseEnter(titleEl!);
    expect(screen.getByRole('tooltip').textContent).toBe(short);
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
