// @vitest-environment jsdom
/**
 * TrackerSyncRejectionBanner rendering: `custodyUnavailable` (the current
 * server-managed rejection) gets its own copy and wins over the legacy
 * codes; legacy `rotationLocked`/`staleKeyEpoch` copy is unchanged.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import { trackerSyncRejectionAtom, type TrackerSyncRejection } from '../../../store/atoms/trackerSync';
import { TrackerSyncRejectionBanner } from '../TrackerSyncRejectionBanner';

const WS = '/ws/banner-test';

function rejection(code: TrackerSyncRejection['code']): TrackerSyncRejection {
  return { workspacePath: WS, code, itemId: 'item-1', timestamp: Date.now() };
}

function setState(partial: Partial<Record<TrackerSyncRejection['code'], TrackerSyncRejection | null>>) {
  store.set(trackerSyncRejectionAtom, {
    staleKeyEpoch: null,
    rotationLocked: null,
    custodyUnavailable: null,
    ...partial,
  });
}

function renderBanner() {
  return render(
    <Provider store={store}>
      <TrackerSyncRejectionBanner workspacePath={WS} />
    </Provider>,
  );
}

describe('TrackerSyncRejectionBanner', () => {
  afterEach(() => {
    cleanup();
    setState({});
  });

  it('renders the custody-unavailable copy for custodyUnavailable', () => {
    setState({ custodyUnavailable: rejection('custodyUnavailable') });
    renderBanner();

    const banner = screen.getByTestId('tracker-sync-rejection-banner');
    expect(banner.getAttribute('data-rejection-code')).toBe('custodyUnavailable');
    expect(banner.textContent).toContain("encryption isn't migrated");
    expect(banner.textContent).toContain("can't sync");
  });

  it('prefers custodyUnavailable over the legacy codes', () => {
    setState({
      custodyUnavailable: rejection('custodyUnavailable'),
      staleKeyEpoch: rejection('staleKeyEpoch'),
      rotationLocked: rejection('rotationLocked'),
    });
    renderBanner();

    expect(
      screen.getByTestId('tracker-sync-rejection-banner').getAttribute('data-rejection-code'),
    ).toBe('custodyUnavailable');
  });

  it('still renders the legacy rotationLocked copy', () => {
    setState({ rotationLocked: rejection('rotationLocked') });
    renderBanner();

    const banner = screen.getByTestId('tracker-sync-rejection-banner');
    expect(banner.getAttribute('data-rejection-code')).toBe('rotationLocked');
    expect(banner.textContent).toContain('rotation in progress');
  });

  it('renders nothing when there is no rejection', () => {
    setState({});
    renderBanner();

    expect(screen.queryByTestId('tracker-sync-rejection-banner')).toBeNull();
  });
});
