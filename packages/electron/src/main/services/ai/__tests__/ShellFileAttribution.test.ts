// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ShellFileAttribution, type ShellAttributionDependencies, type ShellFileState, type ShellFileEvidence, type ShellPersistenceOutcome } from '../ShellFileAttribution';
import { ShellTrackingCoverage } from '../ShellTrackingCoverage';

function fixture(beforeRead?: () => Promise<void>, prepareCheckout?: () => Promise<any>, overrides: Partial<ShellAttributionDependencies> = {}) {
  let now = 1000;
  let emit: (file: string) => void = () => {};
  const state = new Map<string, ShellFileState>();
  const known = new Map<string, string>();
  const persist = vi.fn(async (_e: ShellFileEvidence): Promise<ShellPersistenceOutcome> => 'persisted');
  const unsubscribe = vi.fn();
  const report = vi.fn();
  const service = new ShellFileAttribution({
    subscribe: async (_w, fn) => {
      emit = fn;
      return unsubscribe;
    },
    prepareCheckout,
    read: async (f) => {
      await beforeRead?.();
      return state.get(f) ?? null;
    },
    knownWrite: (f, s) => known.has(f) && known.get(f) === s?.fingerprint,
    otherSessions: () => [],
    persist,
    report,
    retryDelayMs: 0,
    now: () => now,
    settleMs: 0,
    ...overrides,
  });
  return {
    service,
    report,
    persist,
    known,
    unsubscribe,
    write: (file: string, fingerprint: string) => {
      now++;
      state.set(file, { fingerprint, modifiedAt: now });
      emit(file);
    },
    event: (file: string) => emit(file),
    advance: (ms = 1) => now += ms,
  };
}
describe('shell hook attribution', () => {
  it.each(['one', 'neither', 'both'] as const)('resolves overlapping Bash commands when %s names the changed path', async names => {
    const coverage = new ShellTrackingCoverage({ load: async () => undefined, save: async () => {}, notify: () => {} });
    const f = fixture(undefined, async () => ({
      defer: async () => true,
      finish: async () => new Map([['/workspace/named.ts', 'edit']]),
    }), { report: (...args) => coverage.record(...args) });
    const a = await f.service.register('A', '/workspace');
    const b = await f.service.register('B', '/workspace');
    await coverage.open('A', a);
    await coverage.open('B', b);
    await f.service.pre(a, 'sleep', 'Bash', {}, names === 'both' ? 'cat /workspace/named.ts' : 'sleep 30; touch ./other.ts');
    await f.service.pre(b, 'writer', 'Bash', {}, names === 'neither' ? 'npm test' : "printf edit > ./nested/../named.ts");
    f.write('/workspace/named.ts', 'changed');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled(); // The winner must still await checkout reconciliation.
    await f.service.post(b, 'writer');
    await f.service.post(a, 'sleep');
    if (names === 'one') {
      expect(f.persist.mock.calls.map(([e]) => [e.sessionId, e.toolUseId, e.filePath])).toEqual([['B', 'writer', '/workspace/named.ts']]);
    } else expect(f.persist).not.toHaveBeenCalled();
    const summaries = await coverage.readMany(['A', 'B']);
    for (const summary of summaries) {
      expect(summary.reasons).toEqual(names === 'one' ? {} : { competingOwners: 1 });
      expect(summary.state).toBe('no-detected-fault');
    }
    await f.service.release(a);
    await f.service.release(b);
    await coverage.close(a);
    await coverage.close(b);
  });

  it.each(['lost observation', 'mixed tools'] as const)('does not override %s with a unique command match', async kind => {
    const f = fixture();
    const a = await f.service.register('A', '/workspace');
    const b = await f.service.register('B', '/workspace');
    await f.service.pre(a, 'other', kind === 'mixed tools' ? 'apply_patch' : 'Bash');
    await f.service.pre(b, 'writer', 'Bash', {}, 'printf edit > ./named.ts');
    if (kind === 'lost observation') f.service.watcherLost('/workspace');
    f.write('/workspace/named.ts', 'edit');
    await f.service.post(b, 'writer');
    await f.service.post(a, 'other');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.report.mock.calls.map(([, reason]) => reason)).toContain(kind === 'mixed tools' ? 'competingOwners' : 'observationGap');
    await f.service.release(a);
    await f.service.release(b);
  });

  it('distinguishes the capture deadline from a rejection and cannot adopt a late baseline', async () => {
    vi.useFakeTimers();
    let finish!: (baseline: any) => void;
    const preparing = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
    const f = fixture(undefined, preparing);
    const a = await f.service.register('A', '/workspace');
    try {
      const pre = f.service.pre(a, 'timeout', 'Bash');
      await vi.advanceTimersByTimeAsync(1250);
      await pre;
      expect(f.report).toHaveBeenCalledWith(a, 'checkoutBaseline', undefined, 'timeout', {
        tool: 'Bash', error: 'capture timeout: 1250 ms budget exceeded',
      });
      finish({ defer: async () => true, finish: async () => new Map([['/workspace/rebuilt.d.ts', 'edit']]) });
      await Promise.resolve();
      f.write('/workspace/rebuilt.d.ts', 'identical');
      const completed = f.service.completed(a, 'timeout');
      await vi.advanceTimersByTimeAsync(1);
      await completed;
      expect(f.persist).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await f.service.release(a);
    }
  });

  it.each(['defer', 'ambiguous defer', 'finish'] as const)('retains bounded %s failures and abstains', async site => {
    const error = new Error('git failed ' + 'x'.repeat(300));
    const f = fixture(undefined, async () => ({
      defer: async () => { if (site !== 'finish') throw error; return true; },
      finish: async () => { throw error; },
    }));
    const a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'failure', 'Bash', { sessionId: 'root' });
    if (site === 'ambiguous defer') f.service.started(a, 'competing', 'mcp');
    f.write('/workspace/rebuilt.d.ts', 'identical');
    await f.service.completed(a, 'failure');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledWith(a, 'checkoutBaseline', undefined, 'failure', {
      tool: 'Bash', hookSessionId: 'root', error: `${site === 'finish' ? 'finish' : 'defer'} failed: ${error.message}`.slice(0, 200),
    });
    await f.service.release(a);
  });

  it('keeps an MCP start ambiguous without a pending writer or unmatched-tool fault', async () => {
    const activity = vi.fn(async () => {});
    const f = fixture(undefined, undefined, { activity });
    const a = await f.service.register('A', '/workspace');
    f.service.started(a, 'question', 'mcp');
    expect(activity).not.toHaveBeenCalled();
    await f.service.pre(a, 'shell', 'Bash');
    f.write('/workspace/overlap.ts', 'ambiguous');
    await f.service.post(a, 'shell');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.report.mock.calls.map(([, reason]) => reason)).toEqual(['toolOverlap']);
    f.report.mockClear();
    f.service.endTurn(a);
    expect(f.report).not.toHaveBeenCalled();
    expect(f.service.getStats().activeWindows).toBe(0);
    await f.service.release(a);
  });
  it.each(['Bash', 'apply_patch'])('silently retires event-free %s windows and clears their durable marker', async tool => {
    const activity = vi.fn(async () => {});
    const f = fixture(undefined, undefined, { activity });
    const a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'empty', tool);
    f.service.endTurn(a);
    expect(f.report).not.toHaveBeenCalled();
    expect(f.service.getStats().activeWindows).toBe(0);
    expect(activity).toHaveBeenLastCalledWith(a, 'empty', false);
    await f.service.pre(a, 'empty', tool);
    expect(f.service.getStats().activeWindows).toBe(0);
    await f.service.release(a);
  });

  it.each([{ turnId: 'child-turn' }, { turnId: 'root-turn', agentType: '' }, { agentType: 'worker' }])('fences foreign pre and post hooks without disturbing a root window: %j', async identity => {
    const activity = vi.fn(async () => {});
    const f = fixture(undefined, undefined, { currentTurn: () => 'root-turn', activity });
    const a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'foreign', 'Bash', { sessionId: 'root-session', ...identity });
    expect(f.service.getStats().activeWindows).toBe(0);
    expect(activity).not.toHaveBeenCalled();
    f.write('/workspace/subagent.ts', 'candidate');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled();
    // Session identity is diagnostic only; old hooks without turn_id still work.
    await f.service.pre(a, 'root', 'Bash', { sessionId: 'another-session' });
    await f.service.post(a, 'root', { tool: 'Bash', ...identity });
    expect(f.service.getStats().activeWindows).toBe(1);
    f.write('/workspace/root.ts', 'owned');
    await f.service.post(a, 'root');
    expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/root.ts']);
    expect(f.report.mock.calls.map(([, reason]) => reason)).toEqual(['foreignTool', 'foreignTool']);
    await f.service.release(a);
  });

  it('records missing-pre and stale-pre context without inventing absent hook identity', async () => {
    const f = fixture(undefined, undefined, { currentTurn: () => 'root' });
    const a = await f.service.register('A', '/workspace');
    f.service.started(a, 'missing', 'shell');
    await f.service.completed(a, 'missing');
    expect(f.report).toHaveBeenCalledWith(a, 'missingPre', undefined, 'missing', { tool: 'Uninstrumented' });
    await f.service.pre(a, 'missing', 'Bash', { turnId: 'root' });
    expect(f.report).toHaveBeenLastCalledWith(a, 'staleEvent', undefined, 'missing', {
      tool: 'Bash', hookTurnId: 'root', turnMatched: true,
    });
    await f.service.release(a);
  });

  it('does not open an old-turn hook after checkout preparation crosses a turn boundary', async () => {
    let turn = 'old';
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const preparing = vi.fn(async () => { await gate; return undefined; });
    const f = fixture(undefined, preparing, { currentTurn: () => turn });
    const a = await f.service.register('A', '/workspace');
    const pre = f.service.pre(a, 'slow-pre', 'Bash', { turnId: 'old' });
    await vi.waitFor(() => expect(preparing).toHaveBeenCalled());
    f.service.endTurn(a);
    turn = 'new';
    finish();
    await pre;
    expect(f.service.getStats().activeWindows).toBe(0);
    expect(f.report.mock.calls.map(([, reason]) => reason)).toEqual(['foreignTool']);
    await f.service.release(a);
  });

  it.each(['Bash', 'apply_patch'])('does not silently retire %s with a queued file event', async tool => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(() => gate);
    const a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'queued', tool);
    f.write('/workspace/queued.ts', 'candidate');
    f.service.endTurn(a);
    expect(f.report.mock.calls.map(([, reason]) => reason)).toContain('unmatchedTool');
    release();
    await f.service.release(a);
  });

  it('waits for terminal cleanup that arrives while the next pre-hook is flushing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const f = fixture(() => ++reads === 1 ? gate : Promise.resolve());
    const a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'lookup', 'mcp__fixture__fail_lookup');
    f.write('/workspace/during-lookup.ts', 'ambiguous');
    const next = f.service.pre(a, 'next-shell', 'Bash');
    await Promise.resolve();
    const completed = f.service.post(a, 'lookup');
    release();
    await next;
    f.write('/workspace/next.ts', 'owned');
    await f.service.post(a, 'next-shell');
    await completed;
    expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/next.ts']);
    await f.service.release(a);
  });

  it('drains a terminal MCP window before the next shell pre-hook, retaining real overlap', async () => {
    const f = fixture(), a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'lookup', 'mcp__fixture__fail_lookup');
    await f.service.pre(a, 'overlapping-shell', 'Bash');
    f.write('/workspace/overlap.ts', 'ambiguous');
    await f.service.post(a, 'overlapping-shell');
    // The protocol receives completion but cannot await it before the next hook.
    const completed = f.service.completed(a, 'lookup');
    const duplicate = f.service.completed(a, 'lookup');
    await f.service.pre(a, 'next-shell', 'Bash');
    f.write('/workspace/next.ts', 'owned');
    await f.service.post(a, 'next-shell');
    await Promise.all([completed, duplicate]);
    expect(f.persist.mock.calls.map(([e]) => [e.filePath, e.toolUseId])).toEqual([
      ['/workspace/next.ts', 'next-shell'],
    ]);
    expect(f.service.getStats().ambiguous).toBe(1);
    expect(f.report.mock.calls.map(([, r]) => r)).not.toContain('missingPre');
    await f.service.release(a);
  });

  it('records sequential owners without using a dirty Git baseline or inventing a diff', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace'),
      b = await f.service.register('B', '/workspace');
    f.write('/workspace/shared.ts', 'pre-dirty');
    await f.service.flush();
    await f.service.pre(a, 'read', 'Bash');
    f.event('/workspace/shared.ts');
    await f.service.post(a, 'read');
    expect(f.persist).not.toHaveBeenCalled();
    await f.service.pre(a, 'one', 'Bash');
    f.write('/workspace/shared.ts', 'A');
    await f.service.post(a, 'one');
    await f.service.pre(b, 'same-content-rewrite', 'Bash');
    f.write('/workspace/shared.ts', 'A');
    await f.service.post(b, 'same-content-rewrite');
    await f.service.pre(b, 'two', 'Bash');
    f.write('/workspace/shared.ts', 'B');
    await f.service.post(b, 'two');
    expect(f.persist.mock.calls.map(([e]) => e)).toEqual([
      expect.objectContaining({
        sessionId: 'A',
        toolUseId: 'one',
        source: 'shell-hook-inferred',
        filePath: '/workspace/shared.ts',
      }),
      expect.objectContaining({
        sessionId: 'B',
        toolUseId: 'two',
        source: 'shell-hook-inferred',
        filePath: '/workspace/shared.ts',
      }),
    ]);
    await f.service.release(a);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await f.service.release(b);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('captures ambiguity at event arrival and suppresses known saves and structured tools', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace'),
      b = await f.service.register('B', '/workspace');
    await f.service.pre(a, 'reader', 'Bash');
    await f.service.pre(b, 'writer', 'Bash');
    f.write('/workspace/b.ts', 'B');
    await f.service.post(b, 'writer');
    await f.service.post(a, 'reader');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.service.getStats().ambiguous).toBe(1);
    await f.service.pre(a, 'shell', 'Bash');
    f.known.set('/workspace/edit.ts', 'editor');
    f.write('/workspace/edit.ts', 'editor');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled();
    f.write('/workspace/edit.ts', 'agent-after-save');
    await f.service.flush();
    expect(f.persist).toHaveBeenCalledTimes(1);
    await f.service.pre(b, 'patch', 'apply_patch');
    f.write('/workspace/patch.ts', 'patch');
    await f.service.post(b, 'patch');
    await f.service.post(a, 'shell');
    expect(f.persist).toHaveBeenCalledTimes(1);
  });
  it('ignores released generations and never credits outside-workspace paths', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'old', 'Bash');
    await f.service.release(a);
    await f.service.pre(a, 'late', 'Bash');
    f.write('/workspace/late.ts', 'late');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled();
    const b = await f.service.register('B', '/workspace');
    await f.service.pre(b, 'new', 'Bash');
    f.write('/workspace-other/file.ts', 'outside');
    await f.service.post(b, 'new');
    expect(f.persist).not.toHaveBeenCalled();
  });
});

it('abstains after registry overflow until turn cleanup and ignores events between turns', async () => {
  const f = fixture(),
    a = await f.service.register('A', '/workspace');
  for (let i = 0; i < 257; i++) await f.service.pre(a, String(i), 'Bash');
  f.write('/workspace/overflow.ts', 'dropped');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  f.service.endTurn(a);
  f.write('/workspace/late.ts', 'late');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  await f.service.pre(a, 'next', 'Bash');
  f.write('/workspace/next.ts', 'next');
  await f.service.post(a, 'next');
  expect(f.persist).toHaveBeenCalledTimes(1);
  await f.service.release(a);
});

it('keeps an overlapping event ambiguous when one candidate exits before the queued read', async () => {
  const f = fixture(),
    a = await f.service.register('A', '/workspace'),
    b = await f.service.register('B', '/workspace');
  await f.service.pre(a, 'one', 'Bash');
  await f.service.pre(b, 'two', 'Bash');
  f.write('/workspace/mixed.ts', 'B');
  await f.service.release(b);
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  await f.service.release(a);
});


it('reports lost pre-hooks and rejects delayed pre-hooks after terminal cleanup', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  f.service.started(a, 'no-hook', 'shell');
  f.write('/workspace/missed.ts', 'unknown');
  await f.service.completed(a, 'no-hook');
  await f.service.pre(a, 'no-hook', 'Bash');
  f.write('/workspace/late.ts', 'unknown');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.report.mock.calls.map(([, reason]) => reason)).toEqual(expect.arrayContaining(['missingPre', 'staleEvent']));
  await f.service.pre(a, 'good', 'Bash');
  f.write('/workspace/good.ts', 'owned');
  await f.service.post(a, 'good');
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/good.ts']);
  await f.service.release(a);
});

it('retries original evidence and reports quota or exhausted saves without recording success', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  f.persist.mockRejectedValueOnce(Error('busy'));
  await f.service.pre(a, 'first', 'Bash');
  f.write('/workspace/retried.ts', 'A');
  await f.service.completed(a, 'first');
  expect(f.persist).toHaveBeenCalledTimes(2);
  expect(f.persist.mock.calls[0][0]).toEqual(f.persist.mock.calls[1][0]);
  f.persist.mockResolvedValue('throttled');
  await f.service.pre(a, 'second', 'Bash');
  f.write('/workspace/dropped.ts', 'B');
  await f.service.completed(a, 'second');
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('throttled');
  f.persist.mockResolvedValue('quota');
  await f.service.pre(a, 'third', 'Bash');
  f.write('/workspace/quota.ts', 'C');
  await f.service.completed(a, 'third');
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('quota');
  f.persist.mockResolvedValue('persisted');
  await f.service.pre(a, 'fourth', 'Bash');
  f.write('/workspace/dropped.ts', 'D');
  await f.service.completed(a, 'fourth');
  expect(f.persist.mock.calls.at(-1)?.[0].toolUseId).toBe('fourth');
  await f.service.release(a);
});

it('bounds commit drains and preserves uncertainty when both completion signals disappear', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => gate), a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'stuck', 'Bash');
  f.write('/workspace/queued.ts', 'A');
  expect(await f.service.drain(['A'], 5)).toBe(false);
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('drainTimeout');
  f.service.endTurn(a);
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('unmatchedTool');
  release();
  await f.service.flush();
  await f.service.release(a);
});


it('abstains for one command when the pre-hook drain times out, not for the rest of the turn', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let gated = true;
  const f = fixture(() => gated ? gate : Promise.resolve(), undefined, { preDrainMs: 5 });
  const a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'big-build', 'Bash');
  f.write('/workspace/slow-hash.ts', 'A');
  await f.service.pre(a, 'during-backlog', 'Bash');
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('drainTimeout');
  gated = false;
  f.write('/workspace/unattributable.ts', 'B');
  release();
  await f.service.post(a, 'during-backlog');
  await f.service.post(a, 'big-build');
  await f.service.pre(a, 'after-backlog', 'Bash');
  f.write('/workspace/recovered.ts', 'C');
  await f.service.post(a, 'after-backlog');
  expect(f.persist.mock.calls.map(([e]) => [e.filePath, e.toolUseId])).toEqual([
    ['/workspace/slow-hash.ts', 'big-build'],
    ['/workspace/recovered.ts', 'after-backlog'],
  ]);
  await f.service.release(a);
});

it('shares links with a concurrent uninstrumented session instead of withholding them', async () => {
  const f = fixture(undefined, undefined, { otherSessions: () => ['claude-session'] });
  const a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'shell', 'Bash');
  f.write('/workspace/shared.ts', 'codex');
  await f.service.post(a, 'shell');
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/shared.ts']);
  expect(f.report.mock.calls.map(([, r]) => r)).toEqual(['uninstrumented']);
  expect(f.service.getStats().ambiguous).toBe(0);
  await f.service.release(a);
});

it('lets an in-flight completion persist and clear its tool marker before release', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const activity = vi.fn(async () => {});
  const f = fixture(undefined, async () => ({
    defer: async () => true,
    finish: async (candidates: Array<{ filePath: string }>) => { await gate; return new Map(candidates.map(c => [c.filePath, 'edit'])); },
  }), { activity });
  const a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'last-command', 'Bash');
  f.write('/workspace/deferred.ts', 'A');
  const completing = f.service.post(a, 'last-command');
  const released = f.service.release(a);
  setTimeout(finish, 5);
  await Promise.all([completing, released]);
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/deferred.ts']);
  expect(activity.mock.calls.at(-1)).toEqual([a, 'last-command', false]);
});

it.each(['drain', 'release', 'queued'] as const)('reconciles turn-end checkout evidence before %s completes and ignores later writes', async boundary => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const activity = vi.fn(async () => {});
  const reconcile = vi.fn(async () => {
    await gate;
    return new Map([['/workspace/edit.ts', 'edit'], ['/workspace/same.ts', 'unchanged'], ['/workspace/copy.ts', 'initialization']]);
  });
  const f = fixture(boundary === 'queued' ? () => gate : undefined, async () => ({ defer: async () => true, finish: reconcile }), { activity });
  const a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'orphan', 'Bash');
  for (const name of ['edit', 'same', 'copy']) f.write(`/workspace/${name}.ts`, name);
  if (boundary !== 'queued') await f.service.flush();
  if (boundary !== 'release') expect(f.service.endTurn(a)).toBeUndefined();
  let settled = false;
  const done = (boundary === 'release' ? f.service.release(a) : f.service.drain(['A'])).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(settled).toBe(false);
  expect(activity).toHaveBeenLastCalledWith(a, 'orphan', true);
  f.write('/workspace/after-turn.ts', 'unrelated');
  finish();
  await done;
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/edit.ts']);
  expect(f.report.mock.calls.map(([, reason]) => reason)).toEqual(['unmatchedTool', 'initialization']);
  expect(activity).toHaveBeenLastCalledWith(a, 'orphan', false);
  await f.service.release(a);
});

it('does not turn a slow quit-time drain into a coverage fault', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => gate), a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'last', 'Bash');
  f.write('/workspace/pending.ts', 'A');
  // The read never resolves inside the bounded quit wait; release must still return without a fault.
  await f.service.release(a);
  expect(f.report.mock.calls.map(([, r]) => r)).not.toContain('drainTimeout');
  release();
});

it('reports watcher loss and recovers on the next turn without importing missed changes', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'before', 'Bash');
  f.service.watcherLost('/workspace');
  f.write('/workspace/lost.ts', 'unobserved');
  await f.service.post(a, 'before');
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('watcherLoss');
  f.service.endTurn(a);
  f.service.watcherRecovered('/workspace');
  await f.service.pre(a, 'after', 'Bash');
  f.event('/workspace/lost.ts');
  f.write('/workspace/future.ts', 'observed');
  await f.service.post(a, 'after');
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/future.ts']);
  await f.service.release(a);
});


it('does not blame idle sessions or turn a watcher outage into overlap; recovers within the turn', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  const idle = await f.service.register('idle', '/workspace');
  await f.service.pre(a, 'interrupted', 'Bash');
  f.service.watcherLost('/workspace');
  expect(f.report.mock.calls.map(([g, r]) => [g, r])).toEqual([[a, 'watcherLoss']]);
  f.service.watcherRecovered('/workspace');
  await f.service.pre(a, 'during-old-window', 'Bash');
  f.write('/workspace/ambiguous.ts', 'unknown');
  await f.service.post(a, 'during-old-window');
  await f.service.post(a, 'interrupted');
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.report.mock.calls.map(([, r]) => r)).not.toContain('overlap');
  await f.service.pre(a, 'fresh-boundary', 'Bash');
  f.write('/workspace/good.ts', 'owned');
  await f.service.post(a, 'fresh-boundary');
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/good.ts']);
  await f.service.release(a);
  await f.service.release(idle);
});

it('does not convert a long-running acknowledged tool into a permanent coverage gap', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'long-build', 'Bash');
  f.advance(6 * 60_000);
  f.write('/workspace/real-edit.ts', 'owned');
  await f.service.post(a, 'long-build');
  expect(f.report.mock.calls.map(([, r]) => r)).not.toContain('suspiciousWindow');
  expect(f.persist).toHaveBeenCalledTimes(1);
  await f.service.release(a);
});


it('bounds authored links after reconciling a large checkout without charging initialization copies', async () => {
  const f = fixture(undefined, async () => ({
    defer: async () => true,
    finish: async (candidates: Array<{filePath: string}>) => new Map(candidates.map(c => [c.filePath, 'edit'])),
  }));
  const a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'checkout-many-edits', 'Bash');
  for (let i = 0; i < 501; i++) f.write(`/workspace/file-${i}.ts`, `edit-${i}`);
  await f.service.post(a, 'checkout-many-edits');
  expect(f.persist).toHaveBeenCalledTimes(500);
  expect(f.report.mock.calls.map(([, reason]) => reason)).toContain('overflow');
  await f.service.release(a);
});
