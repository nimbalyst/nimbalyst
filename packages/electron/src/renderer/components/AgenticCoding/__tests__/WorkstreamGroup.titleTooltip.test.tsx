// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null, resolveProviderIcon: (provider: string) => provider }));
vi.mock('@nimbalyst/runtime/utils/clipboard', () => ({ copyToClipboard: () => {} }));
vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showInfo: () => {}, showError: () => {} },
}));
vi.mock('../../../dialogs', () => ({
  dialogRef: { current: null },
  DIALOG_IDS: { SHARE: 'share' },
}));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../SessionRelativeTime', () => ({ SessionRelativeTime: () => null }));

import { WorkstreamGroup } from '../WorkstreamGroup';

const groupTitle = 'A workstream name that is long enough to be clipped by the session pane';
const childTitle = 'A child session name that is long enough to be clipped by the session pane';

const setElementWidth = (element: Element, { clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number }) => {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
};

afterEach(() => cleanup());

describe('WorkstreamGroup - full name on hover', () => {
  it('shows the merged session header name only when clipped', () => {
    const { container } = render(
      <WorkstreamGroup
        type="workstream"
        id="workstream-1"
        title={groupTitle}
        isExpanded
        isActive={false}
        onToggle={() => {}}
        onSelect={() => {}}
        sessions={[{ id: 'session-1', parentSessionId: 'workstream-1', title: childTitle, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 } as any]}
        activeSessionId={null}
        onSessionSelect={() => {}}
      />,
    );

    const childName = container.querySelector('.session-list-item-title')!;
    setElementWidth(childName, { clientWidth: 160, scrollWidth: 300 });
    fireEvent.mouseEnter(childName);
    expect(screen.getByRole('tooltip').textContent).toBe(childTitle);

    fireEvent.mouseLeave(childName);
    setElementWidth(childName, { clientWidth: 320, scrollWidth: 300 });
    fireEvent.mouseEnter(childName);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
