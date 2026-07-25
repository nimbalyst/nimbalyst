import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutomationScheduler, type OnAutomationFire } from '../AutomationScheduler';
import { parseAutomationStatus } from '../../frontmatter/parser';

/**
 * Minimal in-memory filesystem satisfying the scheduler's ExtensionFileSystem.
 * Keys are workspace-relative paths.
 */
function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    fileExists: async (path: string) => files.has(path),
    findFiles: async (_pattern: string) => {
      // Only supports the automations glob the scheduler uses.
      const prefix = 'nimbalyst-local/automations/';
      return [...files.keys()].filter(
        (p) => p.startsWith(prefix) && p.endsWith('.md') && !p.slice(prefix.length).includes('/'),
      );
    },
  };
}

function makeUi() {
  return { showInfo: vi.fn(), showWarning: vi.fn(), showError: vi.fn() };
}

function automationFile(opts: {
  id: string;
  enabled?: boolean;
  scheduleYaml: string;
  nextRun?: string;
  lastRun?: string;
  runCount?: number;
}): string {
  const enabled = opts.enabled ?? true;
  const nextRunLine = opts.nextRun ? `\n  nextRun: "${opts.nextRun}"` : '';
  const lastRunLine = opts.lastRun ? `\n  lastRun: "${opts.lastRun}"` : '';
  return `---
automationStatus:
  id: ${opts.id}
  title: ${opts.id} title
  enabled: ${enabled}
  schedule:
${opts.scheduleYaml}
  output:
    mode: new-file
    location: nimbalyst-local/automations/${opts.id}/
    fileNameTemplate: "{{date}}-output.md"
  runCount: ${opts.runCount ?? 0}${nextRunLine}${lastRunLine}
---

Do the thing for ${opts.id}.
`;
}

const okFire: OnAutomationFire = async () => ({ success: true, response: 'done', sessionId: 's1', outputFile: 'out.md' });

describe('AutomationScheduler timer firing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires an enabled interval automation once after the interval elapses', async () => {
    const path = 'nimbalyst-local/automations/hourly.md';
    const fs = makeFs({
      [path]: automationFile({ id: 'hourly', scheduleYaml: '    type: interval\n    intervalMinutes: 60' }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    const fire = vi.fn(okFire);
    scheduler.setOnFire(fire);

    await scheduler.initialize();
    expect(fire).not.toHaveBeenCalled();

    // Advance just past the 60-minute interval.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 2000);

    expect(fire).toHaveBeenCalledTimes(1);
    const status = parseAutomationStatus(fs.files.get(path)!);
    expect(status?.runCount).toBe(1);

    scheduler.dispose();
  });

  it('does not fire before the interval elapses', async () => {
    const path = 'nimbalyst-local/automations/hourly.md';
    const fs = makeFs({
      [path]: automationFile({ id: 'hourly', scheduleYaml: '    type: interval\n    intervalMinutes: 60' }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    const fire = vi.fn(okFire);
    scheduler.setOnFire(fire);

    await scheduler.initialize();
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(fire).not.toHaveBeenCalled();

    scheduler.dispose();
  });

  it('honors a persisted nextRun already in the past by catching up once', async () => {
    const path = 'nimbalyst-local/automations/overdue.md';
    // nextRun 5 minutes in the past — app was closed through the due time.
    const pastNextRun = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const fs = makeFs({
      [path]: automationFile({
        id: 'overdue',
        scheduleYaml: '    type: interval\n    intervalMinutes: 60',
        nextRun: pastNextRun,
      }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    const fire = vi.fn(okFire);
    scheduler.setOnFire(fire);

    await scheduler.initialize();
    // Let the immediate catch-up fire (delay ~0).
    await vi.advanceTimersByTimeAsync(2000);
    expect(fire).toHaveBeenCalledTimes(1);

    // Cadence resumes: another full interval before the next run, no burst.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(fire).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('does not catch up the same overdue occurrence again after restarting during its run', async () => {
    const path = 'nimbalyst-local/automations/restart-safe.md';
    const pastNextRun = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const fs = makeFs({
      [path]: automationFile({
        id: 'restart-safe',
        scheduleYaml: '    type: interval\n    intervalMinutes: 60',
        nextRun: pastNextRun,
      }),
    });
    const firstScheduler = new AutomationScheduler(fs, makeUi());
    let finish!: (result: Awaited<ReturnType<OnAutomationFire>>) => void;
    const firstFire = vi.fn(() => new Promise<Awaited<ReturnType<OnAutomationFire>>>((resolve) => {
      finish = resolve;
    }));
    firstScheduler.setOnFire(firstFire);

    await firstScheduler.initialize();
    const firstRun = firstScheduler.runNow(path);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstFire).toHaveBeenCalledTimes(1);
    expect(Date.parse(parseAutomationStatus(fs.files.get(path)!)?.nextRun ?? '')).toBeGreaterThan(Date.now());

    // Simulate restarting while the AI session is still running. The new
    // scheduler must honor the durable claim made before execution started.
    firstScheduler.dispose();
    const restartedScheduler = new AutomationScheduler(fs, makeUi());
    const restartedFire = vi.fn(okFire);
    restartedScheduler.setOnFire(restartedFire);
    await restartedScheduler.initialize();
    await vi.advanceTimersByTimeAsync(2000);

    expect(restartedFire).not.toHaveBeenCalled();

    finish({ success: true, response: 'done', sessionId: 's1', outputFile: 'out.md' });
    await firstRun;
    restartedScheduler.dispose();
  });

  it('repairs a stale due time when that occurrence already finished', async () => {
    const path = 'nimbalyst-local/automations/stale-completed.md';
    const staleNextRun = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const laterLastRun = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const fs = makeFs({
      [path]: automationFile({
        id: 'stale-completed',
        scheduleYaml: '    type: daily\n    time: "07:00"',
        nextRun: staleNextRun,
        lastRun: laterLastRun,
      }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    const fire = vi.fn(okFire);
    scheduler.setOnFire(fire);

    await scheduler.initialize();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fire).not.toHaveBeenCalled();
    expect(Date.parse(parseAutomationStatus(fs.files.get(path)!)?.nextRun ?? '')).toBeGreaterThan(Date.now());
    scheduler.dispose();
  });

  it('fires a long (>24h) schedule exactly once at the true time, not early at the cap', async () => {
    const path = 'nimbalyst-local/automations/weekly.md';
    // Weekly schedule ~ up to 7 days out; guaranteed > 24h in most cases.
    // Force a far-future target via a persisted nextRun 3 days out.
    const nextRun = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const fs = makeFs({
      [path]: automationFile({
        id: 'weekly',
        scheduleYaml: '    type: weekly\n    days: [mon, tue, wed, thu, fri, sat, sun]\n    time: "09:00"',
        nextRun,
      }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    const fire = vi.fn(okFire);
    scheduler.setOnFire(fire);

    await scheduler.initialize();

    // Past the 24h cap but before the true target — must NOT fire early.
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    expect(fire).not.toHaveBeenCalled();

    // Advance to just past the true 3-day target — fires once at the target,
    // proving the cap re-arm honors the absolute time rather than firing early.
    await vi.advanceTimersByTimeAsync(47 * 60 * 60 * 1000 + 2 * 60 * 1000);
    expect(fire).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('re-arms immediately via applyDefinition when a definition is enabled', async () => {
    const path = 'nimbalyst-local/automations/toggle.md';
    // Start disabled — nothing scheduled.
    const fs = makeFs({
      [path]: automationFile({
        id: 'toggle',
        enabled: false,
        scheduleYaml: '    type: interval\n    intervalMinutes: 60',
      }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    const fire = vi.fn(okFire);
    scheduler.setOnFire(fire);

    await scheduler.initialize();
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    expect(fire).not.toHaveBeenCalled();

    // Header enables with a fresh nextRun 60 min out (as handleToggleEnabled does).
    const enabledContent = automationFile({
      id: 'toggle',
      enabled: true,
      scheduleYaml: '    type: interval\n    intervalMinutes: 60',
      nextRun: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    fs.files.set(path, enabledContent);
    scheduler.applyDefinition(path, enabledContent);

    // Fires 60 min after enable, without waiting for the 30s poll.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 2000);
    expect(fire).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('records a reported execution failure as an error without incrementing the successful run count', async () => {
    const path = 'nimbalyst-local/automations/failing.md';
    const fs = makeFs({
      [path]: automationFile({ id: 'failing', scheduleYaml: '    type: interval\n    intervalMinutes: 60' }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    scheduler.setOnFire(async () => ({
      success: false,
      response: 'Authentication failed',
      error: 'Sign in to OpenAI Codex to continue.',
      outputFile: 'nimbalyst-local/automations/failing/error.md',
    }));

    await scheduler.initialize();
    await scheduler.runNow(path);

    const status = parseAutomationStatus(fs.files.get(path)!);
    expect(status?.lastRunStatus).toBe('error');
    expect(status?.lastRunError).toBe('Sign in to OpenAI Codex to continue.');
    expect(status?.runCount).toBe(0);
    expect(Date.parse(status?.nextRun ?? '')).toBeGreaterThan(Date.now());

    const history = JSON.parse(fs.files.get('nimbalyst-local/automations/failing/history.json')!);
    expect(history).toEqual([
      expect.objectContaining({
        status: 'error',
        error: 'Sign in to OpenAI Codex to continue.',
        outputFile: 'nimbalyst-local/automations/failing/error.md',
      }),
    ]);

    scheduler.dispose();
  });

  it('coalesces overlapping runs of the same automation', async () => {
    const path = 'nimbalyst-local/automations/slow.md';
    const fs = makeFs({
      [path]: automationFile({ id: 'slow', scheduleYaml: '    type: interval\n    intervalMinutes: 60' }),
    });
    const scheduler = new AutomationScheduler(fs, makeUi());
    let finish!: (result: Awaited<ReturnType<OnAutomationFire>>) => void;
    const fire = vi.fn(() => new Promise<Awaited<ReturnType<OnAutomationFire>>>((resolve) => {
      finish = resolve;
    }));
    scheduler.setOnFire(fire);

    await scheduler.initialize();
    const first = scheduler.runNow(path);
    const second = scheduler.runNow(path);
    await Promise.resolve();
    await Promise.resolve();

    expect(fire).toHaveBeenCalledTimes(1);
    finish({ success: true, response: 'done', sessionId: 's1', outputFile: 'out.md' });
    await Promise.all([first, second]);
    expect(parseAutomationStatus(fs.files.get(path)!)?.runCount).toBe(1);

    scheduler.dispose();
  });
});
