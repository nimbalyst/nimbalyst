/**
 * Regression test for the usage-indicator rail restore fix.
 *
 * Before this fix, the "Disable" button on the Claude/Codex/Gemini usage
 * popovers wrote `ai.show*UsageIndicator` (an `ai-settings` boolean) to
 * `false`, but every rail-side restore affordance (right-click "Show X",
 * "Customize Gutter...", "Show All") reads `hiddenGutterItems` instead. A
 * user who disabled an indicator this way had no way to bring it back from
 * the rail. This one-shot migration folds any indicator a user had already
 * disabled into `hiddenGutterItems` so it (a) stays hidden across the
 * upgrade and (b) becomes restorable from the gutter's own UI.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { storeState } = vi.hoisted(() => ({
  storeState: {} as Record<string, Record<string, unknown>>,
}));

// In-memory stand-in for electron-store: real electron-store would try to
// read/write actual files under the mocked app.getPath('userData') path
// (see vitest.setup.ts), which is unnecessary I/O and cross-test pollution
// risk for a pure migration-logic test. Mirrors the MockStore pattern in
// CommitTrackerLinker.test.ts, extended with `set`/`store` since migrations
// write as well as read.
vi.mock('electron-store', () => ({
  default: class MockStore {
    name: string;
    constructor(opts: { name?: string; defaults?: Record<string, unknown> } = {}) {
      this.name = opts.name ?? 'default';
      if (!storeState[this.name]) {
        storeState[this.name] = { ...(opts.defaults ?? {}) };
      }
    }
    get path() {
      return `/mock/${this.name}.json`;
    }
    get(key: string, fallback?: unknown) {
      const data = storeState[this.name] ?? {};
      return key in data ? data[key] : fallback;
    }
    set(key: string, value: unknown) {
      if (!storeState[this.name]) storeState[this.name] = {};
      storeState[this.name][key] = value;
    }
    delete(key: string) {
      delete storeState[this.name]?.[key];
    }
    get store() {
      return storeState[this.name] ?? {};
    }
  },
}));

import { runMigrations } from '../store';

function resetStoreState() {
  for (const key of Object.keys(storeState)) delete storeState[key];
}

describe('runMigrations - usage indicators migrated to gutter hidden set', () => {
  beforeEach(() => {
    resetStoreState();
  });

  it('hides claude-usage in the gutter when ai.showUsageIndicator was explicitly disabled', () => {
    storeState['ai-settings'] = { showUsageIndicator: false };

    runMigrations('1.0.0');

    const hidden = storeState['app-settings']?.hiddenGutterItems as string[] | undefined;
    expect(hidden).toContain('claude-usage');
    expect(storeState['app-settings']?.usageIndicatorsMigratedToGutter).toBe(true);
  });

  it('hides codex-usage in the gutter when ai.showCodexUsageIndicator was explicitly disabled', () => {
    storeState['ai-settings'] = { showCodexUsageIndicator: false };

    runMigrations('1.0.0');

    const hidden = storeState['app-settings']?.hiddenGutterItems as string[] | undefined;
    expect(hidden).toContain('codex-usage');
  });

  it('hides gemini-usage in the gutter when ai.showGeminiUsageIndicator was explicitly disabled', () => {
    storeState['ai-settings'] = { showGeminiUsageIndicator: false };

    runMigrations('1.0.0');

    const hidden = storeState['app-settings']?.hiddenGutterItems as string[] | undefined;
    expect(hidden).toContain('gemini-usage');
  });

  it('does not hide any indicator when the settings are unset (default true)', () => {
    runMigrations('1.0.0');

    const hidden = (storeState['app-settings']?.hiddenGutterItems as string[] | undefined) ?? [];
    expect(hidden).not.toContain('claude-usage');
    expect(hidden).not.toContain('codex-usage');
    expect(hidden).not.toContain('gemini-usage');
  });

  it('preserves items already hidden for unrelated reasons', () => {
    storeState['app-settings'] = { hiddenGutterItems: ['voice-mode'] };
    storeState['ai-settings'] = { showUsageIndicator: false };

    runMigrations('1.0.0');

    const hidden = storeState['app-settings']?.hiddenGutterItems as string[] | undefined;
    expect(hidden).toEqual(expect.arrayContaining(['voice-mode', 'claude-usage']));
  });

  it('is a no-op on a second run so a user who re-enables from the rail after upgrade stays enabled', () => {
    storeState['ai-settings'] = { showUsageIndicator: false };

    runMigrations('1.0.0');
    // Simulate the user restoring it from the gutter's "Show Claude Usage" menu item.
    (storeState['app-settings'] as Record<string, unknown>).hiddenGutterItems = [];

    runMigrations('1.0.1');

    const hidden = storeState['app-settings']?.hiddenGutterItems as string[] | undefined;
    expect(hidden ?? []).not.toContain('claude-usage');
  });
});
