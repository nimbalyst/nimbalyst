// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn() } } }));

import { beginTurnSetup, cancelTurnSetup, TurnSetupCancelledError } from '../turnSetupStages';

function harness() {
  let clock = 0;
  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  return {
    log,
    scheduled,
    advance: (ms: number) => { clock += ms; },
    options: {
      now: () => clock,
      log,
      schedule: (fn: () => void, ms: number) => {
        const entry = { fn, ms, cancelled: false };
        scheduled.push(entry);
        return entry;
      },
      unschedule: (entry: unknown) => { (entry as { cancelled: boolean }).cancelled = true; },
    },
  };
}

it('names a stage that is still running past the threshold, before it finishes', async () => {
  const h = harness();
  const setup = beginTurnSetup('s1', { ...h.options, submissionId: 'sub-1' });
  let release!: () => void;
  const exports = setup.stage('codex-exports', () => new Promise<void>(resolve => { release = resolve; }));

  // The stall never resolving is the case that mattered: the warning fires from the timer.
  h.scheduled.filter(t => !t.cancelled).forEach(t => t.fn());
  expect(h.log.warn).toHaveBeenCalledWith("[TurnSetup] s1 (submission sub-1): stage 'codex-exports' still running after 10000ms");

  h.advance(12_000);
  release();
  await exports;
  setup.finish();
  expect(h.scheduled.every(t => t.cancelled)).toBe(true);
  expect(h.log.info).toHaveBeenCalledWith('[TurnSetup] s1 (submission sub-1): setup 12000ms (codex-exports=12000ms)');
});

it('cancel during a stage stops the turn at the stage boundary, before the provider', async () => {
  const h = harness();
  const setup = beginTurnSetup('s2', h.options);
  const next = vi.fn(async () => {});
  const first = setup.stage('initialize', async () => {
    expect(cancelTurnSetup('s2')).toBe(true);
  });

  await expect(first).rejects.toBeInstanceOf(TurnSetupCancelledError);
  await expect(setup.stage('file-watcher', next)).rejects.toBeInstanceOf(TurnSetupCancelledError);
  expect(next).not.toHaveBeenCalled();
  // The setup is released, so a later cancel does not target a finished turn.
  expect(cancelTurnSetup('s2')).toBe(false);
});

it('a cancel after setup finished does not reach the turn', async () => {
  const h = harness();
  const setup = beginTurnSetup('s3', h.options);
  await setup.stage('inbox', async () => {});
  setup.finish();
  expect(cancelTurnSetup('s3')).toBe(false);
});
