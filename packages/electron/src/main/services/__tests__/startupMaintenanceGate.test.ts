// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  whenFirstUsable,
  signalFirstWindowLoaded,
  runWhenFirstUsable,
  __resetStartupMaintenanceGateForTests,
} from '../startupMaintenanceGate';
import {
  DAILY_MS,
  QUEUED_PROMPT_RETENTION_MS,
  TOOL_RETENTION_ROWS_PER_RUN,
  runToolOutputRetention,
  scheduleDatabaseRetention,
} from '../databaseRetentionMaintenance';

const maintenanceStore = vi.hoisted(() => ({ days: 30, cursor: 0 }));
vi.mock('../../utils/store', () => ({
  getDatabaseMaintenanceSettings: () => ({
    backupCopiesKept: 2,
    backupIntervalHours: 12,
    toolOutputRetentionDays: maintenanceStore.days,
  }),
  getToolOutputRetentionCursor: () => maintenanceStore.cursor,
  setToolOutputRetentionCursor: (id: number) => {
    maintenanceStore.cursor = id;
  },
}));

describe('startupMaintenanceGate', () => {
  afterEach(() => {
    __resetStartupMaintenanceGateForTests();
    vi.useRealTimers();
  });

  it('resolves whenFirstUsable after the first window loads + idle delay', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void whenFirstUsable().then(() => {
      resolved = true;
    });

    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(2499);
    expect(resolved).toBe(false); // idle delay not elapsed yet

    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);
  });

  it('resolves via the ceiling timeout if no window ever loads', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void whenFirstUsable().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);
  });

  it('only the first window signal arms the idle countdown', async () => {
    vi.useFakeTimers();
    let resolved = false;
    void whenFirstUsable().then(() => {
      resolved = true;
    });

    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(1000);
    // A later window signal must not reset/extend the countdown.
    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(1501);
    expect(resolved).toBe(true);
  });

  it('runWhenFirstUsable runs the task after ready and isolates failures', async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    runWhenFirstUsable('boom', () => {
      throw new Error('intentional');
    });
    runWhenFirstUsable('ok', () => {
      ran.push('ok');
    });

    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(2501);
    await Promise.resolve();

    // The throwing task does not prevent the sibling task from running.
    expect(ran).toContain('ok');
  });
});

describe('database retention scheduling', () => {
  beforeEach(() => {
    maintenanceStore.days = 30;
    maintenanceStore.cursor = 0;
  });
  afterEach(() => {
    __resetStartupMaintenanceGateForTests();
    vi.useRealTimers();
  });

  const doneRun = (lastId: number) => ({
    scanned: 1, rewritten: 1, bytesSaved: 10, durationMs: 1, cutoffIso: '', stoppedEarly: false, lastId,
  });

  it('runs nothing at scheduling time, then once after first-usable, then daily', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => 0);
    const toolRetentionRun = vi.fn(async () => doneRun(7));

    scheduleDatabaseRetention({
      getToolRetentionRunner: () => ({ toolRetentionRun }),
      queuedPromptsStore: { cleanup },
    });
    await vi.advanceTimersByTimeAsync(0);
    // Not inline: nothing touches the database until the gate opens.
    expect(cleanup).not.toHaveBeenCalled();
    expect(toolRetentionRun).not.toHaveBeenCalled();

    signalFirstWindowLoaded();
    await vi.advanceTimersByTimeAsync(2501);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(QUEUED_PROMPT_RETENTION_MS);
    expect(toolRetentionRun).toHaveBeenCalledTimes(1);
    expect(toolRetentionRun).toHaveBeenCalledWith(30, TOOL_RETENTION_ROWS_PER_RUN, 0);

    await vi.advanceTimersByTimeAsync(DAILY_MS);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(toolRetentionRun).toHaveBeenCalledTimes(2);
    // The second day resumes from the cursor the first run left behind.
    expect(toolRetentionRun).toHaveBeenLastCalledWith(30, TOOL_RETENTION_ROWS_PER_RUN, 7);
  });

  it('walks bounded requests until the pass finishes, persisting the cursor after each', async () => {
    const toolRetentionRun = vi
      .fn()
      .mockResolvedValueOnce({ ...doneRun(100), stoppedEarly: true })
      .mockResolvedValueOnce(doneRun(180));
    await runToolOutputRetention(() => ({ toolRetentionRun }), async () => {});

    expect(toolRetentionRun.mock.calls).toEqual([
      [30, TOOL_RETENTION_ROWS_PER_RUN, 0],
      [30, TOOL_RETENTION_ROWS_PER_RUN, 100],
    ]);
    expect(maintenanceStore.cursor).toBe(180);
  });

  it('does nothing when retention is set to 0 or the backend is PGLite', async () => {
    const toolRetentionRun = vi.fn();
    maintenanceStore.days = 0;
    await runToolOutputRetention(() => ({ toolRetentionRun }));
    maintenanceStore.days = 30;
    await runToolOutputRetention(() => null);
    expect(toolRetentionRun).not.toHaveBeenCalled();
  });
});
