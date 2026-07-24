import type { ExtensionStorage } from '@nimbalyst/extension-sdk';
import type {
  RunHistory,
  RunRecord,
  TestResultRecord,
  TestRunResult,
  TestNode,
  FlakyTestScore,
} from './types';

const STORAGE_KEY = 'runHistory';
const MAX_RUNS = 50;

export class HistoryStore {
  private history: RunHistory = { runs: [] };
  private storage: ExtensionStorage | null = null;
  private listeners = new Set<(history: RunHistory) => void>();

  async connectStorage(storage: ExtensionStorage) {
    this.storage = storage;
    const saved = storage.get<RunHistory>(STORAGE_KEY);
    if (saved?.runs) {
      this.history = saved;
      this.notify();
    }
  }

  getHistory(): RunHistory {
    return this.history;
  }

  subscribe(listener: (history: RunHistory) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Record a completed test run into history */
  recordRun(result: TestRunResult): RunRecord {
    const testResults = flattenTestResults(result.tree);
    const record: RunRecord = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: result.timestamp,
      configPath: result.configPath,
      totalTests: result.totalTests,
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      flaky: result.flaky,
      durationMs: result.durationMs,
      testResults,
    };

    this.history = {
      runs: [record, ...this.history.runs].slice(0, MAX_RUNS),
    };
    this.persist();
    this.notify();
    return record;
  }

  /** Get tests ranked by failure rate across all recorded runs */
  getFlakyTests(minRuns = 2): FlakyTestScore[] {
    const testStats = new Map<string, { name: string; filePath?: string; total: number; failures: number }>();

    for (const run of this.history.runs) {
      for (const result of run.testResults) {
        const existing = testStats.get(result.testId) ?? {
          name: result.name,
          filePath: result.filePath,
          total: 0,
          failures: 0,
        };
        existing.total++;
        if (result.status === 'failed') {
          existing.failures++;
        }
        testStats.set(result.testId, existing);
      }
    }

    return Array.from(testStats.entries())
      .map(([testId, stats]) => ({
        testId,
        name: stats.name,
        filePath: stats.filePath,
        totalRuns: stats.total,
        failures: stats.failures,
        failureRate: stats.failures / stats.total,
      }))
      .filter((t) => t.totalRuns >= minRuns && t.failures > 0)
      .sort((a, b) => b.failureRate - a.failureRate);
  }

  /** Get duration trend data (timestamp + durationMs per run) */
  getDurationTrend(): Array<{ timestamp: number; durationMs: number; passed: number; failed: number }> {
    return this.history.runs
      .slice()
      .reverse() // chronological order
      .map((r) => ({
        timestamp: r.timestamp,
        durationMs: r.durationMs,
        passed: r.passed,
        failed: r.failed,
      }));
  }

  private async persist() {
    if (!this.storage) return;
    await this.storage.set(STORAGE_KEY, this.history);
  }

  private notify() {
    this.listeners.forEach((l) => l(this.history));
  }
}

function flattenTestResults(tree: TestNode[]): TestResultRecord[] {
  const results: TestResultRecord[] = [];
  for (const node of tree) {
    if (node.type === 'test') {
      results.push({
        testId: node.id,
        name: node.name,
        filePath: node.filePath,
        status: node.status,
        durationMs: node.duration ?? 0,
      });
    }
    results.push(...flattenTestResults(node.children));
  }
  return results;
}

/** Singleton */
let activeStore: HistoryStore | null = null;

export function getHistoryStore(): HistoryStore | null {
  return activeStore;
}

export function setHistoryStore(store: HistoryStore) {
  activeStore = store;
}
