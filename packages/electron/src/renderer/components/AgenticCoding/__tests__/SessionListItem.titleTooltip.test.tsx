// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Keep the component isolated: jotai atom reads return defaults, and the store
// atom families are callable stubs so importing them has no side effects.
vi.mock('jotai', () => ({
  useAtomValue: (atom: string) => atom === 'indicator' ? { kind: 'idle' } : atom === 'activity' ? 0 : undefined,
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
  ProviderIcon: () => null,
  getPhasePresentation: (phase?: string) => phase === 'implementing'
    ? { label: 'Implementing', color: '#eab308', cssVar: '--nim-session-phase-implementing' }
    : null,
}));
// The store atoms are callable stubs (atom families called with a sessionId);
// their values are read through the mocked jotai useAtomValue above, so the
// stub return value never matters. Factories are inlined (no outer ref) to
// avoid the vi.mock hoisting TDZ.
vi.mock('../../../store', () => ({
  reparentSessionAtom: () => ({}),
  refreshSessionListAtom: () => ({}),
  sessionShareAtom: () => ({}),
  sessionLastActivityAtom: () => 'activity',
  sessionIndicatorStateAtom: () => 'indicator',
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
  // The row title carries the full name unconditionally, matching the session
  // tab (WorkstreamSessionTabs sets title={title}). This covers both JS
  // truncation past 40 chars and CSS ellipsis clipping a shorter name in a
  // narrow pane, the gap a >40-char gate would miss.
  it('exposes the full name in title for a long, JS-truncated name', () => {
    const long = 'A very long session name that runs well past the forty character cutoff';
    const { container } = render(<SessionListItem {...baseProps} title={long} />);
    const titleEl = container.querySelector('.session-list-item-title');
    expect(titleEl?.getAttribute('title')).toBe(long);
  });

  it('exposes the full name in title for a short name (could still be CSS-clipped in a narrow pane)', () => {
    const short = 'Short name';
    const { container } = render(<SessionListItem {...baseProps} title={short} />);
    const titleEl = container.querySelector('.session-list-item-title');
    expect(titleEl?.getAttribute('title')).toBe(short);
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

  it('places the canonical phase square after the title and includes it in the row name', () => {
    const { container } = render(
      <SessionListItem {...baseProps} title="Phase row" phase="implementing" />,
    );
    const title = container.querySelector('.session-list-item-title');
    expect(title?.nextElementSibling?.classList.contains('session-list-item-phase-square')).toBe(true);
    const row = container.querySelector('[aria-label^="Session: "]');
    expect(row?.getAttribute('aria-label')).toContain('Phase: Implementing.');
  });
});
