// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { shellCoverageDetails } from '@nimbalyst/runtime/ai/shellTrackingCoverage';
import { ShellTrackingCoverage } from '../ShellTrackingCoverage';

describe('durable shell coverage', () => {
  it('round-trips bounded hook diagnostics in version 1 without changing coverage details', async () => {
    let disk: any = { version: 1, sessionId: 'A', state: 'degraded', reasons: { missingPre: 1 }, turns: [], active: [], events: [{ reason: 'missingPre', at: 1 }] };
    const deps = { load: async () => structuredClone(disk), save: async (_: string, data: any) => { disk = structuredClone(data); }, notify: () => {} };
    const ledger = new ShellTrackingCoverage(deps);
    await ledger.open('A', 'g');
    ledger.turn('g', 'root');
    const context = { tool: 'Bash', hookSessionId: 'child', hookTurnId: 'foreign', turnMatched: false, agentType: 'worker' };
    ledger.record('g', 'unmatchedTool', undefined, 'orphan', context);
    ledger.record('g', 'unmatchedTool', undefined, 'orphan', { ...context, turnMatched: true });
    ledger.record('g', 'checkoutBaseline', undefined, 'baseline', { ...context, error: 'capture failed: ' + 'x'.repeat(300) });
    ledger.record('g', 'checkoutBaseline', undefined, 'baseline', { ...context, error: 'finish failed: git timed out' });
    ledger.record('g', 'checkoutBaseline', undefined, 'baseline', { ...context, error: 'finish failed: git timed out' });
    await ledger.close('g');
    const [summary] = await new ShellTrackingCoverage(deps).readMany(['A']);
    expect(disk.version).toBe(1);
    expect(summary.events).toEqual([
      { reason: 'missingPre', at: 1 },
      expect.objectContaining({ ...context, turnId: 'root', toolUseId: 'orphan' }),
      expect.objectContaining({ ...context, turnMatched: true }),
      expect.objectContaining({ ...context, error: ('capture failed: ' + 'x'.repeat(300)).slice(0, 200) }),
      expect.objectContaining({ ...context, error: 'finish failed: git timed out' }),
    ]);
    expect(shellCoverageDetails([summary])).toEqual(shellCoverageDetails([{ ...summary, events: undefined }]));
    await ledger.open('A', 'g2');
    for (let i = 0; i < 40; i++) ledger.record('g2', 'staleEvent', undefined, String(i), context);
    await ledger.close('g2');
    expect(disk.events).toHaveLength(32);
  });

  it('preserves gaps and interrupted turns across restart without overwriting earlier totals', async () => {
    let disk: any;
    const deps = {
      load: async () => structuredClone(disk),
      save: async (_: string, value: any) => {
        disk = structuredClone(value);
      },
      notify: vi.fn(),
    };
    const first = new ShellTrackingCoverage(deps);
    await first.open('A', 'g1');
    first.turn('g1', 't1');
    await first.tool('g1', 'unfinished-write', true);
    first.record('g1', 'throttled');
    await first.flush(['A']);
    const second = new ShellTrackingCoverage(deps);
    await second.open('A', 'g2');
    second.turn('g2', 't2');
    second.endTurn('g2');
    await second.close('g2');
    const [coverage] = await second.readMany(['A']);
    expect(coverage.state).toBe('degraded');
    expect(coverage.reasons).toMatchObject({ throttled: 1, interrupted: 1 });
    expect(coverage.turns.some((t: any) => t.turnId === 't1' && t.reasons.throttled === 1)).toBe(true);
    const third = new ShellTrackingCoverage(deps);
    expect((await third.readMany(['A']))[0].reasons.interrupted).toBe(1);
  });

  it('does not let old cleanup erase a new turn and never overwrites history after a failed read', async () => {
    let disk: any;
    let rejectLoad = false;
    const save = vi.fn(async (_: string, value: any) => {
      disk = structuredClone(value);
    });
    const deps = {
      load: async () => {
        if (rejectLoad) throw Error('read busy');
        return structuredClone(disk);
      },
      save,
      notify: vi.fn(),
    };
    const first = new ShellTrackingCoverage(deps);
    await first.open('A', 'g1');
    first.turn('g1', 'old');
    first.record('g1', 'quota');
    await first.close('g1');
    save.mockClear();
    rejectLoad = true;
    const second = new ShellTrackingCoverage(deps);
    await second.open('A', 'g2');
    second.turn('g2', 'new');
    second.endTurn('g2', 'old');
    await second.flush(['A']);
    expect(save).not.toHaveBeenCalled();
    rejectLoad = false;
    await second.flush(['A']);
    expect(disk.reasons.quota).toBe(1);
    expect(disk.active).toContain('g2');
  });

  it('reports failed durability and bounds drains even when the store never responds', async () => {
    const ledger = new ShellTrackingCoverage({
      load: async () => undefined,
      save: async () => {
        throw Error('disk full');
      },
      notify: vi.fn(),
    });
    await ledger.open('A', 'g');
    ledger.record('g', 'quota');
    await ledger.flush(['A']);
    expect((await ledger.readMany(['A']))[0].reasons).toMatchObject({
      quota: 1,
      coveragePersistence: expect.any(Number),
    });
    const hung = new ShellTrackingCoverage({
      load: async () => undefined,
      save: async () => new Promise(() => {}),
      notify: vi.fn(),
    });
    await hung.open('B', 'h');
    expect(await hung.flush(['B'], 5)).toBe(false);
  });
});


it('loads legacy age-only diagnostics without a false gap and preserves real history after recovery', async () => {
  const disk: any = { version: 1, sessionId: 'A', state: 'degraded', reasons: { suspiciousWindow: 3 }, turns: [], active: [] };
  const ledger = new ShellTrackingCoverage({ load: async () => disk, save: async () => {}, notify: () => {} });
  expect(shellCoverageDetails(await ledger.readMany(['A']))).toEqual([]);
  await ledger.open('A', 'g');
  ledger.turn('g', 't');
  ledger.observation('g', false);
  ledger.record('g', 'watcherLoss', 't', 'interrupted-command');
  expect(shellCoverageDetails(await ledger.readMany(['A']))).toContain('File observation is currently interrupted');
  ledger.observation('g', true);
  const [summary] = await ledger.readMany(['A']);
  expect(summary).toMatchObject({ observation: 'watching', state: 'degraded', reasons: { suspiciousWindow: 3, watcherLoss: 1 } });
  expect(summary.events).toEqual([expect.objectContaining({ reason: 'watcherLoss', toolUseId: 'interrupted-command', turnId: 't' })]);
  expect(shellCoverageDetails([summary])).toEqual(['The workspace file watcher was interrupted']);
  await ledger.close('g');
  await ledger.unavailable('A');
  expect(shellCoverageDetails(await ledger.readMany(['A']))).toContain('File observation is currently interrupted');
});

it('skips durable writes for non-writing hooks and does not fail a slow clear', async () => {
  let disk: any;
  const save = vi.fn(async (_: string, data: any) => { disk = structuredClone(data); });
  const ledger = new ShellTrackingCoverage({ load: async () => structuredClone(disk), save, notify: () => {} });
  await ledger.open('A', 'g1');
  await ledger.flush(['A']);
  const writes = save.mock.calls.length;
  await ledger.tool('g1', 'mcp-question', false);
  await ledger.tool('g1', 'mcp-question', false);
  expect(save.mock.calls.length).toBe(writes);
  await ledger.tool('g1', 'write', true);
  expect(disk.pendingTools.g1).toEqual(['write']);
  save.mockImplementation(async () => { throw new Error('busy'); });
  await expect(ledger.tool('g1', 'write', false)).resolves.toBeUndefined();
  await expect(ledger.tool('g1', 'next-write', true)).rejects.toThrow();
});

it('does not turn a thinking-only turn into a missing-file warning after restart', async () => {
  let disk: any;
  const deps = { load: async () => structuredClone(disk), save: async (_: string, data: any) => { disk = structuredClone(data); }, notify: () => {} };
  const first = new ShellTrackingCoverage(deps);
  await first.open('A', 'g1'); first.turn('g1', 'thinking-or-restart-mcp');
  await first.tool('g1', 'finished-write', true);
  await first.tool('g1', 'finished-write', false);
  await first.flush(['A']);
  const restarted = new ShellTrackingCoverage(deps);
  expect((await restarted.readMany(['A']))[0].state).toBe('no-detected-fault');
});

it('keeps the durable tool marker until file persistence drains, but not through an acknowledged restart MCP', async () => {
  const { ShellFileAttribution } = await import('../ShellFileAttribution');
  let disk: any;
  const deps = { load: async () => structuredClone(disk), save: async (_: string, value: any) => { disk = structuredClone(value); }, notify: () => {} };
  const ledger = new ShellTrackingCoverage(deps);
  let emit!: (file: string) => void;
  let release!: () => void;
  const saving = new Promise<void>(resolve => { release = resolve; });
  let now = 1;
  const files = new ShellFileAttribution({
    subscribe: async (_root, changed) => { emit = changed; return () => {}; },
    read: async () => ({ fingerprint: 'authored', modifiedAt: now }),
    persist: async () => { await saving; return 'persisted'; },
    knownWrite: () => false, otherSessions: () => [], now: () => now, settleMs: 0,
    activity: (generation, id, active) => ledger.tool(generation, id, active),
    report: (generation, reason) => ledger.record(generation, reason),
  });
  const generation = await files.register('A', '/workspace');
  await ledger.open('A', generation); ledger.turn(generation, 't');
  await files.pre(generation, 'write', 'Bash');
  now++; emit('/workspace/file.ts');
  const completing = files.post(generation, 'write');
  expect(disk.pendingTools[generation]).toEqual(['write']);
  const crashed = new ShellTrackingCoverage({ ...deps, save: async () => {} });
  expect((await crashed.readMany(['A']))[0].reasons.interrupted).toBe(1);
  release(); await completing;
  await files.pre(generation, 'restart', 'mcp__nimbalyst_extension_dev__restart_nimbalyst');
  expect(disk.active).toEqual([generation]);
  expect(disk.pendingTools).toEqual({});
  const restarted = new ShellTrackingCoverage({ ...deps, save: async () => {} });
  expect((await restarted.readMany(['A']))[0].state).toBe('no-detected-fault');
  await files.release(generation); await ledger.close(generation);
  expect((await ledger.readMany(['A']))[0].state).toBe('no-detected-fault');
});
