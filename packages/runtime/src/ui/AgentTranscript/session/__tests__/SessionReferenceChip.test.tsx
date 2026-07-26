/**
 * SessionReferenceChip icon + navigation contract.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as rtl from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { SessionReferenceChip } from '../SessionReferenceChip';
import { sessionRefMapAtom, type SessionRefMeta } from '../sessionRefAtoms';

const { render, screen, fireEvent, cleanup } = rtl;

const SESSION_ID = '9b1f2a44-1c22-4f0e-9a10-1234567890ab';

function renderChip(meta?: SessionRefMeta, onOpen?: (id: string) => void) {
  const store = createStore();
  if (meta) store.set(sessionRefMapAtom, new Map([[meta.id, meta]]));
  return render(
    <JotaiProvider store={store}>
      <SessionReferenceChip sessionId={SESSION_ID} onOpen={onOpen} />
    </JotaiProvider>,
  );
}

afterEach(cleanup);

describe('SessionReferenceChip', () => {
  it('renders the session provider glyph instead of the generic icon', () => {
    renderChip({ id: SESSION_ID, title: 'PR 978 contribution review', provider: 'claude-code' });

    const icon = document.querySelector('.session-reference-chip-icon');
    expect(icon?.getAttribute('data-provider')).toBe('claude-code');
    // `claude-code` is a custom brand SVG, not a material-symbols ligature.
    expect(icon?.querySelector('svg')).toBeTruthy();
    expect(icon?.textContent).not.toContain('forum');
    expect(screen.getByText('PR 978 contribution review')).toBeTruthy();
  });

  it('falls back to the generic forum glyph when the provider is unknown', () => {
    renderChip({ id: SESSION_ID, title: 'Untitled session' });

    const icon = document.querySelector('.session-reference-chip-icon');
    expect(icon?.textContent).toBe('forum');
  });

  it('uses the host-supplied open handler instead of the window event', () => {
    const onOpen = vi.fn();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderChip({ id: SESSION_ID, title: 'PR 978 contribution review' }, onOpen);

    fireEvent.click(screen.getByText('PR 978 contribution review'));

    expect(onOpen).toHaveBeenCalledWith(SESSION_ID);
    expect(
      dispatch.mock.calls.some(([event]) => (event as CustomEvent).type === 'open-ai-session'),
    ).toBe(false);
    dispatch.mockRestore();
  });

  it('dispatches open-ai-session when no handler is supplied', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    renderChip({ id: SESSION_ID, title: 'PR 978 contribution review' });

    fireEvent.click(screen.getByText('PR 978 contribution review'));

    expect(
      dispatch.mock.calls.some(([event]) => (event as CustomEvent).type === 'open-ai-session'),
    ).toBe(true);
    dispatch.mockRestore();
  });
});
