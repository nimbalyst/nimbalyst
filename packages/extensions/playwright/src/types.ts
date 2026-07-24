export type TestStatus = 'passed' | 'failed' | 'skipped' | 'flaky' | 'running' | 'pending';

/** A named Playwright config profile (e.g. E2E tests vs extension tests) */
export interface TestConfig {
  /** Unique key, e.g. 'e2e' or 'extensions' */
  id: string;
  /** Display label, e.g. 'E2E Tests' */
  label: string;
  /** Path to playwright config file, relative to workspace root */
  configPath: string;
  /** Extra environment variables to pass when running tests */
  env?: Record<string, string>;
}

export interface TestNode {
  id: string;
  type: 'project' | 'file' | 'describe' | 'test';
  name: string;
  /** Relative file path (for file/describe/test nodes) */
  filePath?: string;
  /** Line number in source file */
  line?: number;
  /** Column number in source file */
  column?: number;
  children: TestNode[];
  status: TestStatus;
  duration?: number;
  error?: TestError;
  /** Number of retries */
  retries?: number;
  /** Which config profile this node belongs to (set during merge) */
  configId?: string;
}

export interface TestError {
  message: string;
  stack?: string;
  /** Path to failure screenshot, if captured */
  screenshotPath?: string;
  /** Path to trace ZIP, if captured */
  tracePath?: string;
  /** Expected vs actual for assertion failures */
  expected?: string;
  actual?: string;
}

export interface TestRunResult {
  timestamp: number;
  configPath: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  /** Root nodes (projects) */
  tree: TestNode[];
}

/** JSON reporter output from `npx playwright test --list --reporter=json` */
export interface PlaywrightListOutput {
  config: {
    configFile: string;
    projects: Array<{
      name: string;
      testDir: string;
    }>;
  };
  suites: PlaywrightSuite[];
}

export interface PlaywrightSuite {
  title: string;
  file?: string;
  line?: number;
  column?: number;
  suites?: PlaywrightSuite[];
  specs?: PlaywrightSpec[];
}

export interface PlaywrightSpec {
  title: string;
  file: string;
  line: number;
  column: number;
  tests: Array<{
    projectName: string;
    results: Array<{
      status: string;
      duration: number;
      error?: {
        message: string;
        stack?: string;
      };
      attachments?: Array<{
        name: string;
        path?: string;
        contentType: string;
      }>;
    }>;
  }>;
}

// ============================================================================
// History types
// ============================================================================

export interface RunRecord {
  id: string;
  timestamp: number;
  configPath: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  testResults: TestResultRecord[];
}

export interface TestResultRecord {
  testId: string;
  name: string;
  filePath?: string;
  status: TestStatus;
  durationMs: number;
}

export interface RunHistory {
  runs: RunRecord[];
}

export interface FlakyTestScore {
  testId: string;
  name: string;
  filePath?: string;
  totalRuns: number;
  failures: number;
  failureRate: number;
}

// ============================================================================
// Trace types
// ============================================================================

export interface TraceAction {
  actionId: string;
  type: string;
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
  error?: string;
  /** Index into TraceData.screenshots if this action has one */
  screenshotIndex?: number;
  /** Index into TraceData.snapshots for DOM snapshot */
  snapshotIndex?: number;
  /** Source location */
  location?: { file: string; line: number; column: number };
}

export interface TraceScreenshot {
  actionId: string;
  blobUrl: string;
  timestamp: number;
}

export interface TraceSnapshot {
  actionId: string;
  html: string;
}

export interface TraceData {
  testName: string;
  actions: TraceAction[];
  screenshots: TraceScreenshot[];
  snapshots: TraceSnapshot[];
  totalDuration: number;
  error?: string;
  isElectron: boolean;
}

// ============================================================================
// Playwright JSON reporter types
// ============================================================================

/** JSON reporter output from `npx playwright test --reporter=json` */
export interface PlaywrightRunOutput {
  config: {
    configFile: string;
  };
  suites: PlaywrightSuite[];
  stats: {
    startTime: string;
    duration: number;
    expected: number;
    unexpected: number;
    flaky: number;
    skipped: number;
  };
}
