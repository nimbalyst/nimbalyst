// @vitest-environment jsdom
/**
 * Org mode's gutter item is gated on the project actually belonging to an
 * organization — the same rule Shared Docs uses — and its unread badge is the
 * mode's only discoverability affordance, so a project without an org must not
 * offer a mode that has nothing to show.
 *
 * The gutter also reads the org from `useProjectOrg`, never from
 * `selectedOrgIdAtom`: that atom belongs to the standalone org window, and both
 * surfaces can be alive at once.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';

import { selectedOrgIdAtom } from '../../../store/atoms/orgScope';
import { EMPTY_TEAM_INBOX_SNAPSHOT, teamInboxSnapshotAtom } from '../../../store/atoms/teamInbox';
import { activeExtensionPanelAtom } from '../../../store/atoms/extensionPanels';
import { windowModeAtom, setWindowModeAtom } from '../../../store/atoms/windowMode';

const projectOrg = vi.hoisted(() => ({ current: null as { orgId: string; name: string } | null }));
const extensionButtons = vi.hoisted(() => ({ current: [] as Array<{ id: string; label: string; icon: string; placement: 'sidebar'; isAlpha: boolean }> }));

vi.mock('../../../hooks/useProjectOrg', () => ({
  useProjectOrg: () => ({ org: projectOrg.current, loading: false }),
}));
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../extensions/panels/usePanels', () => ({
  useExtensionGutterButtons: () => extensionButtons.current,
  useExtensionBottomPanelButtons: () => [],
}));
vi.mock('../AgentSessionsPopover', () => ({ AgentSessionsPopover: () => null }));
vi.mock('../../Accounts/AccountInspectorPopover', () => ({ AccountInspectorPopover: () => null }));
vi.mock('../../ThemeToggleButton/ThemeToggleButton', () => ({ ThemeToggleButton: () => null }));
vi.mock('../../SyncStatusButton/SyncStatusButton', () => ({ SyncStatusButton: () => null }));
vi.mock('../../TrustIndicator', () => ({ TrustIndicator: () => null }));
vi.mock('../../ExtensionDevIndicator', () => ({ ExtensionDevIndicator: () => null }));
vi.mock('../../ClaudeUsageIndicator', () => ({ ClaudeUsageIndicator: () => null }));
vi.mock('../../CodexUsageIndicator', () => ({ CodexUsageIndicator: () => null }));
vi.mock('../../GeminiUsageIndicator', () => ({ GeminiUsageIndicator: () => null }));
vi.mock('../../UnifiedAI/VoiceModeButton', () => ({ VoiceModeButton: () => null }));

import { NavigationGutter } from '../NavigationGutter';

afterEach(() => {
  cleanup();
  projectOrg.current = null;
  extensionButtons.current = [];
});

function renderGutter(store = createStore(), onContentModeChange = vi.fn()) {
  render(
    <Provider store={store}>
      <NavigationGutter
        contentMode="files"
        onContentModeChange={onContentModeChange}
        workspacePath="/workspace"
      />
    </Provider>,
  );
  return onContentModeChange;
}

describe('Org mode gutter item', () => {
  it('keeps a deliberately opened sidebar panel after navigating from Agent to Files', () => {
    const store = createStore();
    store.set(windowModeAtom, 'agent');
    extensionButtons.current = [{ id: 'extension.sidebar', label: 'Session Tree', icon: 'account_tree', placement: 'sidebar', isAlpha: false }];
    render(
      <Provider store={store}>
        <NavigationGutter
          contentMode="agent"
          onContentModeChange={(mode) => store.set(setWindowModeAtom, mode)}
          onExtensionPanelChange={(id) => store.set(activeExtensionPanelAtom, id)}
          workspacePath="/workspace"
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Session Tree' }));
    expect(store.get(windowModeAtom)).toBe('files');
    expect(store.get(activeExtensionPanelAtom)).toBe('extension.sidebar');
  });

  it('is absent when the project has no organization', () => {
    renderGutter();
    expect(screen.queryByTestId('org-mode-button')).toBeNull();
  });

  it('switches to Org mode without touching the window\'s org selection, and badges unread', () => {
    projectOrg.current = { orgId: 'org-project', name: 'Project Org' };
    const store = createStore();
    // The standalone window is pointed somewhere else; the mode must not care.
    store.set(selectedOrgIdAtom, 'org-elsewhere');
    store.set(teamInboxSnapshotAtom, {
      ...EMPTY_TEAM_INBOX_SNAPSHOT,
      status: 'ready',
      deliveries: [1, 2, 3].map((n) => ({
        id: `d${n}`,
        teamMemberId: 'member-1' as never,
        orgId: 'org-project',
        orgName: 'Project Org',
        createdAt: n,
        hasUnreadActivity: true,
      })),
    });

    const onContentModeChange = renderGutter(store);
    expect(screen.getByTestId('org-mode-unread').textContent).toBe('3');

    fireEvent.click(screen.getByTestId('org-mode-button'));
    expect(onContentModeChange).toHaveBeenCalledWith('org');
    expect(store.get(selectedOrgIdAtom)).toBe('org-elsewhere');
  });
});
