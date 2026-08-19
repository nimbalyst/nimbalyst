import { describe, it, expect, vi } from 'vitest';
import { resolveClaudeCliEffort, type ResolveClaudeCliEffortDeps } from '../claudeCliEffort';
import type { EffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';

/**
 * #844: the Agent SDK path forwards the selected effort to the CLI as
 * CLAUDE_CODE_EFFORT_LEVEL. The interactive CLI path never did, so the effort
 * selector was inert for a `claude-code-cli` session — every launch ran at
 * whatever the CLI defaults to, regardless of what the UI showed.
 *
 * Resolution order mirrors the SDK path: explicit, then the session's own
 * selection, then the app default.
 */
function harness(over: {
  sessionEffort?: EffortLevel | null;
  appDefault?: EffortLevel;
  throws?: boolean;
} = {}) {
  const getSessionEffortLevel = vi.fn(async (): Promise<unknown> => {
    if (over.throws) throw new Error('db down');
    return over.sessionEffort ?? undefined;
  });
  const logWarn = vi.fn();
  const deps: ResolveClaudeCliEffortDeps = {
    getSessionEffortLevel,
    getDefaultEffortLevel: () => over.appDefault,
    // Mirrors the real helper: a valid session value wins, else the app default.
    resolveEffortLevel: (sessionEffort, appDefault) =>
      (typeof sessionEffort === 'string' ? (sessionEffort as EffortLevel) : undefined) ?? appDefault,
    logWarn,
  };
  return { getSessionEffortLevel, logWarn, deps };
}

describe('resolveClaudeCliEffort', () => {
  it('uses an explicit value without touching the session store', async () => {
    const h = harness({ sessionEffort: 'low', appDefault: 'medium' });
    await expect(
      resolveClaudeCliEffort({ explicit: 'max', sessionId: 's1' }, h.deps),
    ).resolves.toBe('max');
    expect(h.getSessionEffortLevel).not.toHaveBeenCalled();
  });

  it("falls back to the session's own selection", async () => {
    const h = harness({ sessionEffort: 'xhigh', appDefault: 'medium' });
    await expect(resolveClaudeCliEffort({ sessionId: 's1' }, h.deps)).resolves.toBe('xhigh');
  });

  it('falls back to the app default when the session has no selection', async () => {
    const h = harness({ sessionEffort: null, appDefault: 'medium' });
    await expect(resolveClaudeCliEffort({ sessionId: 's1' }, h.deps)).resolves.toBe('medium');
  });

  it('returns undefined when nothing is configured, leaving the CLI on its own default', async () => {
    const h = harness({});
    await expect(resolveClaudeCliEffort({ sessionId: 's1' }, h.deps)).resolves.toBeUndefined();
  });

  /**
   * A failed session lookup must not block the launch — degrade to the app
   * default rather than throwing out of the spawn path.
   */
  it('degrades to the app default when the session lookup throws', async () => {
    const h = harness({ appDefault: 'high', throws: true });
    await expect(resolveClaudeCliEffort({ sessionId: 's1' }, h.deps)).resolves.toBe('high');
    expect(h.logWarn).toHaveBeenCalled();
  });

  it('never rejects, even with no logger attached', async () => {
    const h = harness({ throws: true });
    const deps = { ...h.deps, logWarn: undefined };
    await expect(resolveClaudeCliEffort({ sessionId: 's1' }, deps)).resolves.toBeUndefined();
  });

  /** "high" is a real selection, not an absence — #844 was exactly this bug. */
  it('forwards "high" rather than treating it as unset', async () => {
    const h = harness({ sessionEffort: 'high' });
    await expect(resolveClaudeCliEffort({ sessionId: 's1' }, h.deps)).resolves.toBe('high');
  });
});
