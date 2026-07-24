import type { ExtensionAITool } from '@nimbalyst/extension-sdk';
import { getRunner } from './testRunner';
import { getHistoryStore } from './historyStore';
import type { TestNode } from './types';

function flattenTests(nodes: TestNode[]): TestNode[] {
  const result: TestNode[] = [];
  for (const node of nodes) {
    if (node.type === 'test') {
      result.push(node);
    }
    result.push(...flattenTests(node.children));
  }
  return result;
}

export const aiTools: ExtensionAITool[] = [
  {
    name: 'playwright.list_tests',
    access: { kind: 'filesystem' } as const,
    description: 'List all Playwright tests in the project with their hierarchy and current status from the last run. Supports multiple test configs (e.g. E2E tests and extension tests). If no tests have been discovered yet, returns the command to run for discovery.',
    inputSchema: {
      type: 'object',
      properties: {
        jsonOutput: {
          type: 'string',
          description: 'Raw JSON output from `npx playwright test --list --reporter=json`. If provided, parses and stores the test list.',
        },
        configId: {
          type: 'string',
          description: 'Config profile to use (e.g. "e2e", "ext-csv-spreadsheet"). If omitted, uses the active config.',
        },
      },
    },
    scope: 'global',
    handler: async (params) => {
      const runner = getRunner();
      if (!runner) {
        return { success: false, error: 'Playwright test runner not initialized. Open the Playwright Tests panel first.' };
      }

      const configId = params.configId as string | undefined;

      // If JSON output provided, parse and store it
      if (params.jsonOutput) {
        const tree = runner.parseDiscoveryOutput(params.jsonOutput as string, configId);
        const tests = flattenTests(tree);
        return {
          success: true,
          message: `Discovered ${tests.length} tests`,
          data: { totalTests: tests.length, tree: summarizeTree(tree) },
        };
      }

      // Return cached results or discovery command
      const state = runner.getState();
      if (state.tree.length === 0) {
        return {
          success: true,
          message: 'No tests discovered yet. Run the discovery command and pass the JSON output back.',
          data: {
            command: runner.getDiscoverCommand(configId),
            env: runner.getExecEnv(configId),
            configs: state.configs.map(c => ({ id: c.id, label: c.label })),
            hint: 'Run this command via Bash, then call playwright.list_tests again with the jsonOutput parameter.',
          },
        };
      }

      const tests = flattenTests(state.tree);
      return {
        success: true,
        data: {
          totalTests: tests.length,
          tree: summarizeTree(state.tree),
          configs: state.configs.map(c => ({ id: c.id, label: c.label })),
          activeConfig: state.activeConfigId,
          status: {
            passed: tests.filter((t) => t.status === 'passed').length,
            failed: tests.filter((t) => t.status === 'failed').length,
            skipped: tests.filter((t) => t.status === 'skipped').length,
            flaky: tests.filter((t) => t.status === 'flaky').length,
            pending: tests.filter((t) => t.status === 'pending').length,
          },
        },
      };
    },
  },
  {
    name: 'playwright.run_test',
    access: { kind: 'filesystem' } as const,
    description: 'Run Playwright tests and display results in the test panel. Returns the command to execute. After running, pass the JSON output back to update the panel.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'File path or test name to run. Omit to run all tests.',
        },
        jsonOutput: {
          type: 'string',
          description: 'Raw JSON output from `npx playwright test --reporter=json`. If provided, parses results and updates the test panel.',
        },
        configId: {
          type: 'string',
          description: 'Config profile to use (e.g. "e2e", "ext-csv-spreadsheet"). If omitted, uses the active config.',
        },
      },
    },
    scope: 'global',
    handler: async (params) => {
      const runner = getRunner();
      if (!runner) {
        return { success: false, error: 'Playwright test runner not initialized. Open the Playwright Tests panel first.' };
      }

      const configId = params.configId as string | undefined;

      // If JSON output provided, parse and store results
      if (params.jsonOutput) {
        runner.setRunning(false);
        const result = runner.parseRunOutput(params.jsonOutput as string, configId);
        if (!result) {
          return { success: false, error: runner.getState().error ?? 'Failed to parse test results' };
        }

        return {
          success: true,
          message: `Completed: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped in ${formatDuration(result.durationMs)}`,
          data: {
            passed: result.passed,
            failed: result.failed,
            skipped: result.skipped,
            flaky: result.flaky,
            duration: formatDuration(result.durationMs),
            failures: flattenTests(result.tree)
              .filter((t) => t.status === 'failed')
              .map((t) => ({
                name: t.name,
                file: t.filePath,
                error: t.error?.message,
              })),
          },
        };
      }

      // Return the command to run
      const scope = params.scope as string | undefined;
      runner.setRunning(true);
      if (configId) {
        runner.setActiveConfig(configId);
      }
      return {
        success: true,
        message: 'Run this command via Bash, then call playwright.run_test again with the jsonOutput parameter to update the panel.',
        data: {
          command: runner.getRunCommand(scope, undefined, configId),
          env: runner.getExecEnv(configId),
          hint: 'Playwright exits non-zero on test failures but still outputs valid JSON to stdout. Capture stdout regardless of exit code.',
        },
      };
    },
  },
  {
    name: 'playwright.get_failures',
    access: { kind: 'filesystem' } as const,
    description: 'Get details of failed tests from the most recent test run, including error messages, stack traces, and screenshot paths.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    scope: 'global',
    handler: async () => {
      const runner = getRunner();
      if (!runner) {
        return { success: false, error: 'Playwright test runner not initialized. Open the Playwright Tests panel first.' };
      }

      const state = runner.getState();
      if (!state.lastRun) {
        return { success: false, error: 'No test run results available. Run tests first using playwright.run_test.' };
      }

      const failures = flattenTests(state.tree)
        .filter((t) => t.status === 'failed')
        .map((t) => ({
          name: t.name,
          file: t.filePath,
          line: t.line,
          duration: t.duration,
          retries: t.retries,
          error: {
            message: t.error?.message,
            stack: t.error?.stack,
            screenshotPath: t.error?.screenshotPath,
            expected: t.error?.expected,
            actual: t.error?.actual,
          },
        }));

      if (failures.length === 0) {
        return {
          success: true,
          message: 'No failures in the last run.',
          data: { failures: [] },
        };
      }

      return {
        success: true,
        message: `${failures.length} failed test${failures.length > 1 ? 's' : ''}`,
        data: { failures },
      };
    },
  },
  // --- New tools: flaky tests and trace analysis ---
  {
    name: 'playwright.get_flaky_tests',
    access: { kind: 'filesystem' } as const,
    description: 'Get tests ranked by failure rate across recorded test runs. Shows which tests fail most often and how frequently.',
    inputSchema: {
      type: 'object',
      properties: {
        minRuns: {
          type: 'number',
          description: 'Minimum number of runs a test must appear in to be included (default: 2)',
        },
      },
    },
    scope: 'global',
    handler: async (params) => {
      const store = getHistoryStore();
      if (!store) {
        return { success: false, error: 'History store not initialized. Open the Playwright Tests panel first.' };
      }

      const history = store.getHistory();
      if (history.runs.length === 0) {
        return { success: false, error: 'No test run history available. Run tests first to build history.' };
      }

      const minRuns = (params.minRuns as number | undefined) ?? 2;
      const flakyTests = store.getFlakyTests(minRuns);

      if (flakyTests.length === 0) {
        return {
          success: true,
          message: `No flaky tests found (minimum ${minRuns} runs, ${history.runs.length} total runs recorded).`,
          data: { flakyTests: [], totalRuns: history.runs.length },
        };
      }

      return {
        success: true,
        message: `${flakyTests.length} flaky test${flakyTests.length > 1 ? 's' : ''} found across ${history.runs.length} recorded runs`,
        data: {
          flakyTests: flakyTests.map((t) => ({
            name: t.name,
            file: t.filePath,
            failureRate: `${Math.round(t.failureRate * 100)}%`,
            failures: t.failures,
            totalRuns: t.totalRuns,
          })),
          totalRuns: history.runs.length,
        },
      };
    },
  },
  {
    name: 'playwright.get_history',
    access: { kind: 'filesystem' } as const,
    description: 'Get test run history with pass/fail trends and duration statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of recent runs to return (default: 10)',
        },
      },
    },
    scope: 'global',
    handler: async (params) => {
      const store = getHistoryStore();
      if (!store) {
        return { success: false, error: 'History store not initialized. Open the Playwright Tests panel first.' };
      }

      const history = store.getHistory();
      if (history.runs.length === 0) {
        return { success: false, error: 'No test run history available.' };
      }

      const limit = (params.limit as number | undefined) ?? 10;
      const runs = history.runs.slice(0, limit).map((r) => ({
        timestamp: new Date(r.timestamp).toISOString(),
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        flaky: r.flaky,
        duration: formatDuration(r.durationMs),
        failedTests: r.testResults
          .filter((t) => t.status === 'failed')
          .map((t) => t.name),
      }));

      const trend = store.getDurationTrend();
      const avgDuration = trend.length > 0
        ? trend.reduce((sum, d) => sum + d.durationMs, 0) / trend.length
        : 0;

      return {
        success: true,
        message: `${history.runs.length} runs recorded`,
        data: {
          totalRuns: history.runs.length,
          averageDuration: formatDuration(avgDuration),
          recentRuns: runs,
        },
      };
    },
  },
];

function summarizeTree(nodes: TestNode[], depth = 0): Array<{ name: string; type: string; status: string; children?: unknown[] }> {
  return nodes.map((node) => ({
    name: node.name,
    type: node.type,
    status: node.status,
    ...(node.children.length > 0 && depth < 3 ? { children: summarizeTree(node.children, depth + 1) } : {}),
    ...(node.type === 'test' && node.duration != null ? { duration: `${node.duration}ms` } : {}),
  }));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
