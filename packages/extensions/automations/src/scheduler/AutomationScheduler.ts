/**
 * AutomationScheduler - Discovers automation files and manages timer execution.
 *
 * Runs in the renderer process via the extension's activate() hook.
 * Uses setTimeout chains for scheduling (not setInterval).
 */

import type { AutomationStatus, ExecutionRecord } from '../frontmatter/types';
import { parseAutomationStatus, extractPromptBody, updateAutomationStatus } from '../frontmatter/parser';
import { calculateNextRun, msUntilNextRun } from './scheduleUtils';

interface ExtensionFileSystem {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  fileExists: (path: string) => Promise<boolean>;
  findFiles: (pattern: string) => Promise<string[]>;
}

interface ExtensionUI {
  showInfo: (message: string) => void;
  showWarning: (message: string) => void;
  showError: (message: string) => void;
}

interface ScheduledAutomation {
  filePath: string;
  status: AutomationStatus;
  timerId: ReturnType<typeof setTimeout> | null;
  /**
   * Absolute epoch-ms target for the next run. Resolved once when the
   * automation is (re)scheduled and only recomputed after a run or a
   * schedule/enabled change — so the interval clock survives 30s rescans and
   * restarts instead of resetting to `now + interval` every scan.
   */
  nextRunAt: number | null;
}

/** Result returned by the onFire callback. */
export type AutomationFireResult =
  | {
      success: true;
      response: string;
      sessionId?: string;
      outputFile?: string;
    }
  | {
      success: false;
      response: string;
      error: string;
      outputFile?: string;
    };

/** Callback invoked when an automation fires. */
export type OnAutomationFire = (
  filePath: string,
  status: AutomationStatus,
  prompt: string,
) => Promise<AutomationFireResult>;

export class AutomationScheduler {
  private automations = new Map<string, ScheduledAutomation>();
  private fs: ExtensionFileSystem;
  private ui: ExtensionUI;
  private onFire: OnAutomationFire | null = null;
  private activeRuns = new Map<string, Promise<AutomationFireResult>>();
  private disposed = false;

  constructor(fs: ExtensionFileSystem, ui: ExtensionUI) {
    this.fs = fs;
    this.ui = ui;
  }

  /** Set the callback invoked when an automation timer fires. */
  setOnFire(callback: OnAutomationFire): void {
    this.onFire = callback;
  }

  /** Discover automation files and schedule enabled ones. */
  async initialize(): Promise<void> {
    await this.rescan();
  }

  /** Re-scan the automations directory and update timers. */
  async rescan(): Promise<void> {
    if (this.disposed) return;

    let files: string[];
    try {
      files = await this.fs.findFiles('nimbalyst-local/automations/*.md');
    } catch {
      // Directory might not exist yet
      return;
    }

    const currentPaths = new Set(files);

    // Remove automations whose files no longer exist
    for (const [path, automation] of this.automations) {
      if (!currentPaths.has(path)) {
        this.clearTimer(automation);
        this.automations.delete(path);
      }
    }

    // Add/update automations
    for (const filePath of files) {
      try {
        const content = await this.fs.readFile(filePath);
        const parsedStatus = parseAutomationStatus(content);
        if (!parsedStatus) continue;
        const status = await this.repairStaleCompletedOccurrence(filePath, content, parsedStatus);

        const existing = this.automations.get(filePath);
        if (existing) {
          // Update status and reschedule if changed
          const scheduleChanged =
            JSON.stringify(existing.status.schedule) !== JSON.stringify(status.schedule) ||
            existing.status.enabled !== status.enabled;

          existing.status = status;
          if (scheduleChanged) {
            // Schedule or enabled flag changed — recompute the target from the
            // updated status (honoring a freshly-written nextRun) rather than
            // keeping the old one.
            this.clearTimer(existing);
            existing.nextRunAt = null;
            this.scheduleNext(existing);
          }
          // Otherwise keep the existing timer and nextRunAt untouched so the
          // interval clock is not reset by the 30s poll.
        } else {
          const automation: ScheduledAutomation = {
            filePath,
            status,
            timerId: null,
            nextRunAt: null,
          };
          this.automations.set(filePath, automation);
          this.scheduleNext(automation);
        }
      } catch (err) {
        console.error(`[Automations] Failed to read ${filePath}:`, err);
      }
    }
  }

  /**
   * (Re)schedule an automation immediately from in-memory content, bypassing
   * the 30s disk poll. Called when the document header edits a definition so
   * enabling/toggling takes effect at once instead of after up to 30s. Uses the
   * content the header already holds, so there is no race with the autosave
   * flush to disk.
   */
  applyDefinition(filePath: string, content: string): void {
    if (this.disposed) return;

    const status = parseAutomationStatus(content);
    const existing = this.automations.get(filePath);

    if (!status) {
      if (existing) {
        this.clearTimer(existing);
        this.automations.delete(filePath);
      }
      return;
    }

    if (existing) {
      existing.status = status;
      this.clearTimer(existing);
      existing.nextRunAt = null;
      this.scheduleNext(existing);
    } else {
      const automation: ScheduledAutomation = {
        filePath,
        status,
        timerId: null,
        nextRunAt: null,
      };
      this.automations.set(filePath, automation);
      this.scheduleNext(automation);
    }
  }

  /** Manually run an automation immediately. */
  async runNow(filePath: string): Promise<AutomationFireResult> {
    const activeRun = this.activeRuns.get(filePath);
    if (activeRun) return activeRun;

    const run = this.startRun(filePath).finally(() => {
      if (this.activeRuns.get(filePath) === run) {
        this.activeRuns.delete(filePath);
      }
    });
    this.activeRuns.set(filePath, run);
    return run;
  }

  private async startRun(filePath: string): Promise<AutomationFireResult> {
    const automation = this.automations.get(filePath);
    if (!automation) {
      // Try to load it fresh
      try {
        const content = await this.fs.readFile(filePath);
        const status = parseAutomationStatus(content);
        if (!status) {
          const error = 'No valid automation found in this file.';
          this.ui.showError(error);
          return { success: false, response: error, error };
        }
        return await this.executeAutomation(filePath, status);
      } catch (err) {
        const error = `Failed to run automation: ${err}`;
        this.ui.showError(error);
        return { success: false, response: error, error };
      }
    }

    return this.executeAutomation(automation.filePath, automation.status);
  }

  /** Get all tracked automations. */
  getAutomations(): Array<{ filePath: string; status: AutomationStatus }> {
    return Array.from(this.automations.values()).map((a) => ({
      filePath: a.filePath,
      status: a.status,
    }));
  }

  /** Clean up all timers. */
  dispose(): void {
    this.disposed = true;
    for (const automation of this.automations.values()) {
      this.clearTimer(automation);
    }
    this.automations.clear();
  }

  private scheduleNext(automation: ScheduledAutomation): void {
    if (this.disposed || !automation.status.enabled) return;

    // Resolve the absolute target once. Prefer a persisted `nextRun` (so the
    // clock survives rescans/restarts and an overdue run catches up); fall back
    // to `now + interval` for a freshly-enabled/created automation.
    if (automation.nextRunAt === null) {
      automation.nextRunAt = this.resolveNextRunAt(automation.status);
    }
    if (automation.nextRunAt === null) return; // schedule can never fire

    this.armTimer(automation);
  }

  /**
   * Arm a setTimeout toward `automation.nextRunAt`. The delay is capped at ~24h
   * to avoid setTimeout overflow; when the timer fires early because of the cap,
   * the callback compares against the absolute target and re-arms. This works
   * for interval schedules too, unlike recomputing the schedule at fire time.
   */
  private armTimer(automation: ScheduledAutomation): void {
    if (this.disposed || automation.nextRunAt === null) return;

    const SLACK_MS = 1000;
    const delay = Math.max(0, automation.nextRunAt - Date.now());
    const cappedMs = Math.min(delay, 86_400_000);

    automation.timerId = setTimeout(async () => {
      if (this.disposed) return;

      // Not yet due (the 24h cap fired us early) — re-arm toward the same target.
      if (automation.nextRunAt !== null && Date.now() < automation.nextRunAt - SLACK_MS) {
        this.armTimer(automation);
        return;
      }

      await this.runNow(automation.filePath);

      // Compute the next target from a fresh now (a single overdue run catches
      // up, then cadence resumes going forward).
      const next = calculateNextRun(automation.status.schedule);
      automation.nextRunAt = next ? next.getTime() : null;
      if (automation.nextRunAt !== null) this.armTimer(automation);
    }, cappedMs);
  }

  /**
   * Resolve the initial absolute run target for an automation. Honors a valid
   * persisted `nextRun` (including one already in the past, which triggers an
   * immediate catch-up run); otherwise arms `now + msUntilNextRun`.
   */
  private resolveNextRunAt(status: AutomationStatus): number | null {
    if (status.nextRun) {
      const parsed = Date.parse(status.nextRun);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const ms = msUntilNextRun(status.schedule);
    return ms === null ? null : Date.now() + ms;
  }

  /**
   * Older scheduler versions could record a completed attempt without moving
   * `nextRun`. If `lastRun` proves that the persisted occurrence was already
   * handled, roll it forward instead of treating it as restart catch-up work.
   */
  private async repairStaleCompletedOccurrence(
    filePath: string,
    content: string,
    status: AutomationStatus,
  ): Promise<AutomationStatus> {
    if (!status.nextRun || !status.lastRun) return status;

    const nextRunAt = Date.parse(status.nextRun);
    const lastRunAt = Date.parse(status.lastRun);
    if (
      Number.isNaN(nextRunAt) ||
      Number.isNaN(lastRunAt) ||
      nextRunAt > Date.now() ||
      lastRunAt < nextRunAt
    ) {
      return status;
    }

    const repairedNextRun = calculateNextRun(status.schedule);
    if (!repairedNextRun) return status;

    const nextRun = repairedNextRun.toISOString();
    await this.fs.writeFile(filePath, updateAutomationStatus(content, { nextRun }));
    return { ...status, nextRun };
  }

  private clearTimer(automation: ScheduledAutomation): void {
    if (automation.timerId !== null) {
      clearTimeout(automation.timerId);
      automation.timerId = null;
    }
  }

  private async executeAutomation(filePath: string, status: AutomationStatus): Promise<AutomationFireResult> {
    if (!this.onFire) {
      const error = 'Automation execution is not available.';
      console.warn('[Automations] No onFire callback set, skipping execution');
      this.ui.showError(error);
      return { success: false, response: error, error };
    }

    this.ui.showInfo(`Running automation: ${status.title}`);
    const startTime = Date.now();

    try {
      // Read fresh content to get the latest prompt
      const content = await this.fs.readFile(filePath);
      const prompt = extractPromptBody(content);

      // Claim this scheduled occurrence before starting the AI session. The
      // invocation may remain pending for user input or be interrupted by an
      // app restart, so waiting until completion would leave the old due time
      // on disk and cause startup to catch up the same occurrence again.
      const claimedNextRun = calculateNextRun(status.schedule);
      const claimedContent = updateAutomationStatus(content, {
        nextRun: claimedNextRun?.toISOString(),
      });
      await this.fs.writeFile(filePath, claimedContent);

      const tracked = this.automations.get(filePath);
      if (tracked) {
        tracked.status = {
          ...tracked.status,
          nextRun: claimedNextRun?.toISOString(),
        };
      }

      const result = await this.onFire(filePath, status, prompt);
      // console.log('[Automations] onFire result keys:', Object.keys(result), 'outputFile:', result.outputFile);
      const durationMs = Date.now() - startTime;

      if (!result.success) {
        await this.recordFailure(filePath, status, result.error, durationMs, result.outputFile);
        this.ui.showError(`Automation "${status.title}" failed: ${result.error}`);
        return result;
      }

      // Update frontmatter with run results
      const now = new Date().toISOString();
      const nextRun = calculateNextRun(status.schedule);
      const freshContent = await this.fs.readFile(filePath);
      const updated = updateAutomationStatus(freshContent, {
        lastRun: now,
        lastRunStatus: 'success',
        lastRunError: undefined,
        nextRun: nextRun?.toISOString(),
        runCount: (status.runCount ?? 0) + 1,
      });
      await this.fs.writeFile(filePath, updated);

      // Record execution history
      await this.appendHistory(status, {
        id: `run_${Date.now()}`,
        timestamp: now,
        durationMs,
        status: 'success',
        sessionId: result.sessionId,
        outputFile: result.outputFile,
      });

      // Update in-memory status
      const completedTracked = this.automations.get(filePath);
      if (completedTracked) {
        completedTracked.status = {
          ...completedTracked.status,
          lastRun: now,
          lastRunStatus: 'success',
          lastRunError: undefined,
          nextRun: nextRun?.toISOString(),
          runCount: (status.runCount ?? 0) + 1,
        };
      }

      this.ui.showInfo(`Automation "${status.title}" completed. Output: ${result.response.slice(0, 100)}...`);
      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.recordFailure(filePath, status, errorMsg, durationMs);
      this.ui.showError(`Automation "${status.title}" failed: ${errorMsg}`);
      return {
        success: false,
        response: errorMsg,
        error: errorMsg,
      };
    }
  }

  private async recordFailure(
    filePath: string,
    status: AutomationStatus,
    error: string,
    durationMs: number,
    outputFile?: string,
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      const nextRun = calculateNextRun(status.schedule);
      const freshContent = await this.fs.readFile(filePath);
      const updated = updateAutomationStatus(freshContent, {
        lastRun: now,
        lastRunStatus: 'error',
        lastRunError: error,
        nextRun: nextRun?.toISOString(),
      });
      await this.fs.writeFile(filePath, updated);

      await this.appendHistory(status, {
        id: `run_${Date.now()}`,
        timestamp: now,
        durationMs,
        status: 'error',
        error,
        outputFile,
      });

      const tracked = this.automations.get(filePath);
      if (tracked) {
        tracked.status = {
          ...tracked.status,
          lastRun: now,
          lastRunStatus: 'error',
          lastRunError: error,
          nextRun: nextRun?.toISOString(),
        };
      }
    } catch (recordError) {
      console.error('[Automations] Failed to record automation error:', recordError);
    }
  }

  /** Read execution history for an automation. */
  async getHistory(automationId: string, limit?: number): Promise<ExecutionRecord[]> {
    // Find the automation by ID to get its output location
    for (const automation of this.automations.values()) {
      if (automation.status.id === automationId) {
        return this.readHistory(automation.status, limit);
      }
    }
    return [];
  }

  private getHistoryPath(status: AutomationStatus): string {
    const location = status.output.location.endsWith('/')
      ? status.output.location
      : status.output.location + '/';
    return location + 'history.json';
  }

  private async readHistory(status: AutomationStatus, limit?: number): Promise<ExecutionRecord[]> {
    const historyPath = this.getHistoryPath(status);
    try {
      if (await this.fs.fileExists(historyPath)) {
        const raw = await this.fs.readFile(historyPath);
        const records: ExecutionRecord[] = JSON.parse(raw);
        // Return newest first
        const sorted = records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return limit ? sorted.slice(0, limit) : sorted;
      }
    } catch {
      // History file doesn't exist or is malformed
    }
    return [];
  }

  private async appendHistory(status: AutomationStatus, record: ExecutionRecord): Promise<void> {
    const historyPath = this.getHistoryPath(status);
    // console.log('[Automations] Writing history to:', historyPath);
    try {
      let records: ExecutionRecord[] = [];
      try {
        const exists = await this.fs.fileExists(historyPath);
        // console.log('[Automations] History file exists:', exists);
        if (exists) {
          const raw = await this.fs.readFile(historyPath);
          records = JSON.parse(raw);
        }
      } catch (readErr) {
        console.warn('[Automations] Could not read existing history, starting fresh:', readErr);
      }
      records.push(record);
      // Keep last 100 records
      if (records.length > 100) {
        records = records.slice(-100);
      }
      await this.fs.writeFile(historyPath, JSON.stringify(records, null, 2));
      // console.log('[Automations] History written successfully, records:', records.length);
    } catch (err) {
      console.error('[Automations] Failed to write history:', err);
    }
  }
}
