// @vitest-environment jsdom
/**
 * Regression coverage for the usage-indicator rail restore bug: "Disable" in
 * the Claude/Codex/Gemini usage popovers used to write the standalone
 * `ai.show*UsageIndicator` setting, which has no restore affordance anywhere
 * in the UI. Every rail-side restore surface (right-click "Show X",
 * "Customize Gutter…", "Show All") reads `hiddenGutterItemsAtom` instead, so
 * a disabled indicator was a dead end. "Disable" must hide the item through
 * the same gutter-customization atom the restore UI reads.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { Provider, createStore } from 'jotai';

import { hiddenGutterItemsAtom } from '../../../store/atoms/appSettings';
import { canHideGutterItem, type GutterItemMeta } from '../navGutterItems';

// Bypass @floating-ui/react positioning entirely -- these tests only care
// about what the "Disable" button writes, not popover placement, and
// FloatingPortal's layout effects don't have anything meaningful to attach
// to in jsdom without a real anchor element in the viewport.
vi.mock('../../../hooks/useFloatingMenu', () => ({
  useFloatingMenu: () => ({
    refs: { setFloating: () => {}, setReference: () => {} },
    floatingStyles: {},
    getFloatingProps: () => ({}),
  }),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: () => null,
  ProviderIcon: () => null,
}));

import { claudeUsageAtom } from '../../../store/atoms/claudeUsageAtoms';
import { codexUsageAtom } from '../../../store/atoms/codexUsageAtoms';
import { geminiUsageAtom } from '../../../store/atoms/geminiUsageAtoms';
import { ClaudeUsagePopover } from '../../ClaudeUsageIndicator/ClaudeUsagePopover';
import { CodexUsagePopover } from '../../CodexUsageIndicator/CodexUsagePopover';
import { GeminiUsagePopover } from '../../GeminiUsageIndicator/GeminiUsagePopover';

afterEach(() => cleanup());

function noopRef() {
  return { current: null } as React.RefObject<HTMLElement | null>;
}

describe('usage popover "Disable" hides via the gutter customization atom', () => {
  it('ClaudeUsagePopover Disable adds claude-usage to hiddenGutterItemsAtom', () => {
    const store = createStore();
    store.set(claudeUsageAtom, {
      fiveHour: { utilization: 10, resetsAt: null },
      sevenDay: { utilization: 10, resetsAt: null },
      lastUpdated: Date.now(),
    });

    const { getByText } = render(
      <Provider store={store}>
        <ClaudeUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );

    expect(store.get(hiddenGutterItemsAtom)).not.toContain('claude-usage');
    fireEvent.click(getByText('Disable'));
    expect(store.get(hiddenGutterItemsAtom)).toContain('claude-usage');
  });

  it('CodexUsagePopover Disable adds codex-usage to hiddenGutterItemsAtom', () => {
    const store = createStore();
    // Codex usage now uses the duration-window shape (see codexUsageAtoms).
    // The Disable button renders regardless of limits, so an empty window
    // list is enough to mount the popover far enough to click it.
    store.set(codexUsageAtom, {
      limits: [],
      lastUpdated: Date.now(),
    });

    const { getByText } = render(
      <Provider store={store}>
        <CodexUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );

    expect(store.get(hiddenGutterItemsAtom)).not.toContain('codex-usage');
    fireEvent.click(getByText('Disable'));
    expect(store.get(hiddenGutterItemsAtom)).toContain('codex-usage');
  });

  it('GeminiUsagePopover Disable adds gemini-usage to hiddenGutterItemsAtom', () => {
    const store = createStore();
    store.set(geminiUsageAtom, {
      fiveHour: { utilization: 10, resetsAt: null },
      sevenDay: { utilization: 10, resetsAt: null },
      lastUpdated: Date.now(),
    });

    const { getByText } = render(
      <Provider store={store}>
        <GeminiUsagePopover anchorRef={noopRef()} onClose={() => {}} onRefresh={async () => {}} />
      </Provider>,
    );

    expect(store.get(hiddenGutterItemsAtom)).not.toContain('gemini-usage');
    fireEvent.click(getByText('Disable'));
    expect(store.get(hiddenGutterItemsAtom)).toContain('gemini-usage');
  });
});

// Characterization coverage (already correct pre-fix; these don't flip
// red->green) for the restore-menu filter the fix now has a path to
// exercise: an id present in hiddenGutterItemsAtom is offered as "Show X"
// only if it's still in the live registry.
describe('GutterContextMenu restorableHidden filter (canHideGutterItem / registry membership)', () => {
  const registry: GutterItemMeta[] = [
    { id: 'claude-usage', section: 'indicators', icon: 'speed', label: 'Claude Usage', hideable: true },
    { id: 'codex-usage', section: 'indicators', icon: 'speed', label: 'Codex Usage', hideable: true },
  ];

  function restorableHidden(hiddenIds: string[], items: GutterItemMeta[]): string[] {
    return hiddenIds.filter((id) => items.some((it) => it.id === id));
  }

  it('offers to restore a hidden item that is still in the registry', () => {
    expect(restorableHidden(['claude-usage'], registry)).toEqual(['claude-usage']);
  });

  it('does not offer to restore an id no longer present in the registry (e.g. uninstalled extension panel)', () => {
    expect(restorableHidden(['gemini-usage'], registry)).toEqual([]);
  });

  it('canHideGutterItem allows hiding a non-mode indicator regardless of other hidden items', () => {
    const meta = registry[0];
    expect(canHideGutterItem('claude-usage', meta, [], [])).toBe(true);
  });
});
