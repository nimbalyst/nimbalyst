/**
 * Regression test for issue #276.
 *
 * Before: when `useAtomValue(interactiveWidgetHostAtom(sessionId))` captured
 * a null host (transient state during SessionTranscript's effect re-run, or
 * a session view that hadn't installed a host yet), ToolPermissionWidget
 * returned an early non-interactive shell at the "host is null" branch.
 * The user saw "Waiting..." with no Allow/Deny/Cancel buttons and was
 * stuck indefinitely. benv-nti reported 10+ minutes stuck on v0.58.21 for
 * a `gh api repos/.../contents/...` permission request.
 *
 * After: the widget renders the full interactive UI even when host is null.
 * A visible "Reconnecting to permission backend" note is shown so the user
 * has a clue, and the buttons stay clickable; the click handlers fall back
 * to getInteractiveWidgetHost(sessionId) for a fresh imperative read at
 * click time.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { ToolPermissionWidget } from '../ToolPermissionWidget';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';

// Wrap renders in a Jotai Provider bound to the same singleton store that
// setInteractiveWidgetHost writes to, otherwise the widget reads from
// Jotai's default store and never sees the test setup.
function renderWithStore(ui: React.ReactElement) {
  return render(<JotaiProvider store={store}>{ui}</JotaiProvider>);
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    toolCall: {
      providerToolCallId: 'tool-call-1',
      arguments: {
        requestId: 'req-stuck-on-gh-api',
        toolName: 'Bash',
        rawCommand: 'gh api repos/dotnet/skills/contents/plugins/dotnet-upgrade',
        pattern: 'Bash(gh api:*)',
        patternDisplayName: 'gh api commands',
        isDestructive: false,
        warnings: [],
        workspacePath: '/tmp/workspace',
      },
      result: null,
      ...overrides,
    },
  } as any;
}

function makeFakeHost(): InteractiveWidgetHost {
  return {
    toolPermissionSubmit: vi.fn().mockResolvedValue(undefined),
  } as unknown as InteractiveWidgetHost;
}

describe('ToolPermissionWidget — host-null regression (#276)', () => {
  const sessionId = 'session-stuck';

  beforeEach(() => {
    setInteractiveWidgetHost(sessionId, null);
  });

  it('renders the action buttons even when host is null', () => {
    setInteractiveWidgetHost(sessionId, null);

    renderWithStore(
      <ToolPermissionWidget
        message={makeMessage()}
        sessionId={sessionId}
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    // Before the fix, the widget short-circuited to a Waiting-only shell.
    // The fix means we should see all four interactive buttons even
    // without a host installed.
    expect(screen.getByTestId('tool-permission-deny')).toBeTruthy();
    expect(screen.getByTestId('tool-permission-allow-once')).toBeTruthy();
    expect(screen.getByTestId('tool-permission-allow-session')).toBeTruthy();
    expect(screen.getByTestId('tool-permission-allow-always')).toBeTruthy();
  });

  it('shows a "Reconnecting to permission backend" note when host is null', () => {
    setInteractiveWidgetHost(sessionId, null);

    renderWithStore(
      <ToolPermissionWidget
        message={makeMessage()}
        sessionId={sessionId}
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByTestId('tool-permission-host-reconnecting')).toBeTruthy();
  });

  it('hides the reconnecting note once a host is installed', () => {
    setInteractiveWidgetHost(sessionId, makeFakeHost());

    renderWithStore(
      <ToolPermissionWidget
        message={makeMessage()}
        sessionId={sessionId}
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.queryByTestId('tool-permission-host-reconnecting')).toBeNull();
    expect(screen.getByTestId('tool-permission-deny')).toBeTruthy();
  });

  it('does not regress the no-toolCall guard', () => {
    setInteractiveWidgetHost(sessionId, null);

    const { container } = renderWithStore(
      <ToolPermissionWidget
        message={{ toolCall: null } as any}
        sessionId={sessionId}
        isExpanded={false}
        onToggle={() => {}}
      />,
    );

    // Widget returns null when there's no tool call to render
    expect(container.firstChild).toBeNull();
  });
});
