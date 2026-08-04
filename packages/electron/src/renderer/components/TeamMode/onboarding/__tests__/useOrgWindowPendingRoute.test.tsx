// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ORG_WINDOW_ROUTE,
  orgWindowRouteAtom,
  routeAfterOrgChange,
} from '../../orgWindowState';
import { resetOrgWindowPendingHandoff } from '../pendingRouteHandoff';
import {
  ORG_WINDOW_PENDING_ROUTE_SETTING_KEY,
  pendingGeneralRoute,
} from '../orgWelcomeModel';
import {
  useAcknowledgeOrgWindowPendingRoute,
  useOrgWindowPendingRoute,
} from '../useOrgWindowPendingRoute';

function Harness({
  orgId,
  destinationReady = false,
}: {
  orgId: string | null;
  destinationReady?: boolean;
}) {
  useOrgWindowPendingRoute(orgId);
  useAcknowledgeOrgWindowPendingRoute(
    orgId ?? '',
    'general',
    destinationReady,
  );
  return null;
}

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  resetOrgWindowPendingHandoff();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
});

afterEach(() => cleanup());

/**
 * The hand-off is what turns "invite accepted" into "you are in #general" —
 * without it the new member lands on the Inbox and has to go find the room.
 */
describe('useOrgWindowPendingRoute', () => {
  it('routes the window onto the queued conversation and clears the hand-off', async () => {
    invoke.mockImplementation(async (channel: string) => (
      channel === 'app-settings:get' ? pendingGeneralRoute('org-1') : undefined
    ));
    const store = createStore();

    render(
      <Provider store={store}>
        <Harness orgId="org-1" destinationReady />
      </Provider>,
    );

    await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({
      view: 'conversation',
      conversationId: 'general',
    }));
    expect(invoke).toHaveBeenCalledWith(
      'app-settings:set',
      ORG_WINDOW_PENDING_ROUTE_SETTING_KEY,
      null,
    );
  });

  it('keeps the hand-off durable while the destination directory is still hydrating', async () => {
    invoke.mockImplementation(async (channel: string) => (
      channel === 'app-settings:get' ? pendingGeneralRoute('org-1') : undefined
    ));
    const store = createStore();

    render(
      <Provider store={store}>
        <Harness orgId="org-1" />
      </Provider>,
    );

    await waitFor(() => expect(store.get(orgWindowRouteAtom)).toEqual({
      view: 'conversation',
      conversationId: 'general',
    }));

    // Applying the route is not proof that #general exists yet. A temporary
    // directory failure or a close/restart here must leave the destination for
    // the next org-window mount to replay.
    expect(invoke).not.toHaveBeenCalledWith(
      'app-settings:set',
      ORG_WINDOW_PENDING_ROUTE_SETTING_KEY,
      null,
    );
  });

  it('leaves a window pointed at another organization alone', async () => {
    invoke.mockImplementation(async (channel: string) => (
      channel === 'app-settings:get' ? pendingGeneralRoute('org-1') : undefined
    ));
    const store = createStore();

    render(
      <Provider store={store}>
        <Harness orgId="org-2" />
      </Provider>,
    );

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'app-settings:get',
      ORG_WINDOW_PENDING_ROUTE_SETTING_KEY,
    ));
    expect(store.get(orgWindowRouteAtom)).toEqual(DEFAULT_ORG_WINDOW_ROUTE);
    expect(invoke).not.toHaveBeenCalledWith('app-settings:set', expect.anything(), expect.anything());
  });

  // The org window resets a conversation route when its organization changes,
  // which includes its own first mount. That reset and this asynchronous
  // hand-off can run in either order, and both have to end on #general.
  it('survives the window\'s org-change reset whichever order they run in', async () => {
    invoke.mockImplementation(async (channel: string) => (
      channel === 'app-settings:get' ? pendingGeneralRoute('org-1') : undefined
    ));
    const store = createStore();

    // Order 1: the hand-off lands first, then the window mounts and resets.
    render(
      <Provider store={store}>
        <Harness orgId="org-1" />
      </Provider>,
    );
    await waitFor(() => expect(store.get(orgWindowRouteAtom).view).toBe('conversation'));

    expect(routeAfterOrgChange('org-1', store.get(orgWindowRouteAtom))).toEqual({
      view: 'conversation',
      conversationId: 'general',
    });
    // A different organization's room is still dropped.
    expect(routeAfterOrgChange('org-2', store.get(orgWindowRouteAtom)))
      .toEqual(DEFAULT_ORG_WINDOW_ROUTE);

    cleanup();
    resetOrgWindowPendingHandoff();

    // Order 2: the window resets first, then the hand-off lands.
    const second = createStore();
    second.set(orgWindowRouteAtom, routeAfterOrgChange('org-1', {
      view: 'conversation',
      conversationId: 'stale-room',
    }));
    expect(second.get(orgWindowRouteAtom)).toEqual(DEFAULT_ORG_WINDOW_ROUTE);

    render(
      <Provider store={second}>
        <Harness orgId="org-1" />
      </Provider>,
    );
    await waitFor(() => expect(second.get(orgWindowRouteAtom)).toEqual({
      view: 'conversation',
      conversationId: 'general',
    }));
  });

  it('does nothing before an organization has resolved', async () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <Harness orgId={null} />
      </Provider>,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(store.get(orgWindowRouteAtom)).toEqual(DEFAULT_ORG_WINDOW_ROUTE);
  });
});
