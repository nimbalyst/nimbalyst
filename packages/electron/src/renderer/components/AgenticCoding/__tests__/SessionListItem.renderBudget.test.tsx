// @vitest-environment jsdom
/**
 * Render budget for the session list while sessions stream.
 *
 * The recurring incident: several AI sessions stream at once, and every
 * `ai:message-logged` repaints the whole list — hundreds of rows for one
 * session's token. The architecture that prevents it is per-session atom
 * families: a row subscribes only to its own session's state, so a sibling's
 * activity is invisible to it.
 *
 * That is an invariant no reader can verify by looking at the component, and
 * it has regressed before by someone hoisting a subscription one level up. This
 * measures it instead.
 */

// MUST be the first import: it installs the DevTools hook shim that the render
// profiler reads, and react-dom captures that hook once at module init.
import { measureRenders } from '../../../devtools/renderBudget';

import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionListItem } from '../SessionListItem';
import {
  sessionLastActivityAtom,
  sessionUnreadAtom,
  sessionProcessingAtom,
} from '../../../store/atoms/sessions';

vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../FullTitleTooltip', () => ({ FullTitleTooltip: () => null }));

const SESSION_IDS = ['s1', 's2', 's3', 's4', 's5'];

function SessionList() {
  return (
    <div>
      {SESSION_IDS.map(id => (
        <SessionListItem
          key={id}
          id={id}
          title={`Session ${id}`}
          createdAt={1_700_000_000_000}
          updatedAt={1_700_000_000_000}
          isActive={false}
          onClick={() => {}}
        />
      ))}
    </div>
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { invoke: vi.fn().mockResolvedValue(null), on: vi.fn().mockReturnValue(() => {}), send: vi.fn() },
  });
});

afterEach(() => cleanup());

describe('session list render budget', () => {
  it('repaints one row when one session streams, not the list', async () => {
    const store = createStore();
    render(<Provider store={store}><SessionList /></Provider>);

    // Flush mount effects first. Several of them populate shared registry
    // atoms, and the derived per-session atoms recompute when they land — that
    // is mount cost, not the streaming cost we are measuring.
    await act(async () => { await Promise.resolve(); });

    const budget = await measureRenders(async () => {
      // One session streams: activity ticks, it starts processing, it goes unread.
      await act(async () => {
        store.set(sessionLastActivityAtom('s1'), Date.now());
        store.set(sessionProcessingAtom('s1'), true);
        store.set(sessionUnreadAtom('s1'), true);
      });
    });

    // Only s1's row may repaint. The other four rows have no subscription that
    // s1's writes can reach; if this number climbs, a subscription was hoisted
    // out of the row and every sibling now pays for every token.
    expect(budget.rendersOf('SessionListItem'), budget.report()).toBe(1);
  });

  it('does not repaint any row for a session that is not in the list', async () => {
    const store = createStore();
    render(<Provider store={store}><SessionList /></Provider>);

    // Flush mount effects first. Several of them populate shared registry
    // atoms, and the derived per-session atoms recompute when they land — that
    // is mount cost, not the streaming cost we are measuring.
    await act(async () => { await Promise.resolve(); });

    const budget = await measureRenders(async () => {
      await act(async () => {
        store.set(sessionLastActivityAtom('some-other-session'), Date.now());
        store.set(sessionProcessingAtom('some-other-session'), true);
      });
    });

    expect(budget.totalRenders, budget.report()).toBe(0);
  });

  it('costs the same for one streaming session whether the list has 5 rows or 50', async () => {
    const store = createStore();
    const many = Array.from({ length: 50 }, (_, i) => `many-${i}`);

    render(
      <Provider store={store}>
        <div>
          {many.map(id => (
            <SessionListItem
              key={id}
              id={id}
              title={id}
              createdAt={1_700_000_000_000}
              isActive={false}
              onClick={() => {}}
            />
          ))}
        </div>
      </Provider>,
    );

    await act(async () => { await Promise.resolve(); });

    const budget = await measureRenders(async () => {
      await act(async () => {
        store.set(sessionLastActivityAtom('many-7'), Date.now());
      });
    });

    // The cost of one session's activity must not scale with list length.
    expect(budget.rendersOf('SessionListItem'), budget.report()).toBe(1);
  });
});
