// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../../store';
import { DIALOG_IDS } from '../../dialogs/registry';
import { dialogRef } from '../../contexts/DialogContext';
import { windowModeAtom } from '../../store/atoms/windowMode';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import { FEATURE_USAGE_KEYS, type FeatureUsageKey, type FeatureUsageRecord } from '../../../shared/featureUsage';
import { tipCreateWorktreeSessionRequestAtom } from '../atoms';
import { keyboardShortcutsTip } from '../definitions/keyboard-shortcuts';
import { themeExploreTip } from '../definitions/theme-explore';
import { trackerModeTip } from '../definitions/tracker-mode';
import { worktreeSessionTip } from '../definitions/worktree-session';
import type { TipTriggerContext } from '../types';

function createFeatureUsage(
  counts: Partial<Record<FeatureUsageKey, number>> = {},
): Record<string, FeatureUsageRecord> {
  const timestamp = '2026-05-22T00:00:00.000Z';

  return Object.fromEntries(
    Object.entries(counts).map(([feature, count]) => [
      feature,
      {
        count,
        firstUsed: timestamp,
        lastUsed: timestamp,
      },
    ]),
  );
}

function createContext(
  overrides: Partial<TipTriggerContext> = {},
): TipTriggerContext {
  const featureUsage = overrides.featureUsage ?? createFeatureUsage();

  return {
    currentMode: 'files',
    workspacePath: '/repo',
    isGitRepo: false,
    isWorktreesAvailable: false,
    featureUsage,
    hasBeenUsed: (feature) => (featureUsage[feature]?.count ?? 0) > 0,
    hasReachedCount: (feature, threshold) => (featureUsage[feature]?.count ?? 0) >= threshold,
    ...overrides,
  };
}

describe('contextual tip definitions', () => {
  beforeEach(() => {
    store.set(windowModeAtom, 'files');
    store.set(openSettingsCommandAtom, null);
    store.set(tipCreateWorktreeSessionRequestAtom, 0);
    dialogRef.current = {
      open: vi.fn(),
      close: vi.fn(),
      isOpen: vi.fn(),
      activeDialogs: [],
      confirm: vi.fn(),
      registerDialog: vi.fn(),
    };
  });

  it('shows the tracker tip only after repeated sessions without tracker usage', () => {
    const eligible = createContext({
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.SESSION_CREATED]: 5,
      }),
    });
    const alreadyUsedTracker = createContext({
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.SESSION_CREATED]: 8,
        [FEATURE_USAGE_KEYS.TRACKER_USED]: 1,
      }),
    });

    expect(trackerModeTip.trigger.condition(eligible)).toBe(true);
    expect(trackerModeTip.trigger.condition(alreadyUsedTracker)).toBe(false);
  });

  it('opens tracker mode from the tracker tip action', () => {
    trackerModeTip.content.action?.onClick();

    expect(store.get(windowModeAtom)).toBe('tracker');
  });

  it('shows the shortcuts tip only after repeated launches without shortcut usage', () => {
    const eligible = createContext({
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.APP_LAUNCH]: 7,
      }),
    });
    const alreadyUsedShortcut = createContext({
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.APP_LAUNCH]: 10,
        [FEATURE_USAGE_KEYS.KEYBOARD_SHORTCUT_USED]: 1,
      }),
    });

    expect(keyboardShortcutsTip.trigger.condition(eligible)).toBe(true);
    expect(keyboardShortcutsTip.trigger.condition(alreadyUsedShortcut)).toBe(false);
  });

  it('opens the keyboard shortcuts dialog from the shortcuts tip action', () => {
    keyboardShortcutsTip.content.action?.onClick();

    expect(dialogRef.current?.open).toHaveBeenCalledWith(DIALOG_IDS.KEYBOARD_SHORTCUTS, {});
  });

  it('shows the theme tip only after repeated launches without a theme change', () => {
    const eligible = createContext({
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.APP_LAUNCH]: 5,
      }),
    });
    const alreadyChangedTheme = createContext({
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.APP_LAUNCH]: 9,
        [FEATURE_USAGE_KEYS.THEME_CHANGED]: 1,
      }),
    });

    expect(themeExploreTip.trigger.condition(eligible)).toBe(true);
    expect(themeExploreTip.trigger.condition(alreadyChangedTheme)).toBe(false);
  });

  it('opens themes settings from the theme tip action', () => {
    themeExploreTip.content.action?.onClick();

    expect(store.get(openSettingsCommandAtom)).toMatchObject({
      category: 'themes',
    });
  });

  it('shows the worktree tip only for established git workspaces outside an existing worktree', () => {
    const eligible = createContext({
      currentMode: 'agent',
      workspacePath: '/repo',
      isGitRepo: true,
      isWorktreesAvailable: true,
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.SESSION_CREATED]: 10,
      }),
    });
    const alreadyInWorktree = createContext({
      currentMode: 'agent',
      workspacePath: '/repo/_worktrees/topic-branch',
      isGitRepo: true,
      isWorktreesAvailable: true,
      featureUsage: createFeatureUsage({
        [FEATURE_USAGE_KEYS.SESSION_CREATED]: 12,
      }),
    });

    expect(worktreeSessionTip.trigger.condition(eligible)).toBe(true);
    expect(worktreeSessionTip.trigger.condition(alreadyInWorktree)).toBe(false);
  });

  it('requests a worktree session from the worktree tip action', () => {
    worktreeSessionTip.content.action?.onClick();

    expect(store.get(windowModeAtom)).toBe('agent');
    expect(store.get(tipCreateWorktreeSessionRequestAtom)).toBe(1);
  });
});
