// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('jotai', () => ({
  useAtomValue: () => ({}),
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
  ProviderIcon: () => null,
  copyToClipboard: () => {},
}));
vi.mock('../../../store', () => ({
  sessionProcessingAtom: () => ({}),
  sessionUnreadAtom: () => ({}),
  sessionPendingPromptAtom: () => ({}),
  sessionHasPendingInteractivePromptAtom: () => ({}),
  groupSessionStatusAtom: () => ({}),
  reparentSessionAtom: () => ({}),
  refreshSessionListAtom: () => ({}),
  sessionShareAtom: () => ({}),
  removeSessionShareAtom: () => ({}),
  shareKeysAtom: () => ({}),
  buildShareUrl: () => '',
}));
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

afterEach(() => cleanup());

describe('WorkstreamGroup - full name on hover', () => {
  it('wraps complete workstream and child session names in in-app tooltips', () => {
    const { container } = render(
      <WorkstreamGroup
        type="workstream"
        id="workstream-1"
        title={groupTitle}
        isExpanded
        isActive={false}
        onToggle={() => {}}
        onSelect={() => {}}
        sessions={[{ id: 'session-1', title: childTitle, createdAt: 1_700_000_000_000 } as any]}
        activeSessionId={null}
        onSessionSelect={() => {}}
      />,
    );

    const groupName = container.querySelector('.workstream-group-name');
    fireEvent.mouseEnter(groupName!);
    expect(screen.getByRole('tooltip').textContent).toBe(groupTitle);

    fireEvent.mouseLeave(groupName!);
    const childName = container.querySelector('.workstream-session-item-title');
    fireEvent.mouseEnter(childName!);
    expect(screen.getByRole('tooltip').textContent).toBe(childTitle);
  });
});
