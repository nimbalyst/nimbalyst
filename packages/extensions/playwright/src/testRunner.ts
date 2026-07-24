import type {
  TestConfig,
  TestNode,
  TestRunResult,
  TestStatus,
  PlaywrightListOutput,
  PlaywrightRunOutput,
  PlaywrightSuite,
} from './types';
import type { ExtensionStorage } from '@nimbalyst/extension-sdk';

const STORAGE_KEY_TREE = 'testTree';
const STORAGE_KEY_LAST_RUN = 'lastRun';
const STORAGE_KEY_CONFIGS = 'testConfigs';
const STORAGE_KEY_ACTIVE_CONFIG = 'activeConfigId';
const STORAGE_KEY_CONFIG_TREES = 'configTrees';

/** State shared between panel UI and AI tools */
export interface TestRunnerState {
  tree: TestNode[];
  lastRun: TestRunResult | null;
  isRunning: boolean;
  /** Currently active config (used for running tests) */
  activeConfigId: string;
  configs: TestConfig[];
  workspacePath: string;
  error: string | null;
}

type StateListener = (state: TestRunnerState) => void;

/**
 * Core test runner state manager with multi-config support.
 *
 * Manages multiple Playwright configs (e.g. E2E tests + extension tests).
 * Each config produces its own test tree; the merged tree groups them under
 * top-level config-group nodes when multiple configs are active.
 */
export class TestRunner {
  private state: TestRunnerState;
  private listeners = new Set<StateListener>();
  private storage: ExtensionStorage | null = null;
  /** Per-config test trees, keyed by config id */
  private configTrees = new Map<string, TestNode[]>();

  constructor(workspacePath: string, configs: TestConfig[]) {
    const activeId = configs[0]?.id ?? 'default';
    this.state = {
      tree: [],
      lastRun: null,
      isRunning: false,
      activeConfigId: activeId,
      configs,
      workspacePath,
      error: null,
    };
  }

  /** Connect to extension storage and load persisted state */
  async connectStorage(storage: ExtensionStorage) {
    this.storage = storage;

    // Load persisted per-config trees
    const savedConfigTrees = storage.get<Record<string, TestNode[]>>(STORAGE_KEY_CONFIG_TREES);
    if (savedConfigTrees) {
      for (const [id, nodes] of Object.entries(savedConfigTrees)) {
        this.configTrees.set(id, nodes);
      }
    }

    // Load persisted active config
    const savedActiveConfig = storage.get<string>(STORAGE_KEY_ACTIVE_CONFIG);
    if (savedActiveConfig && this.state.configs.some(c => c.id === savedActiveConfig)) {
      this.state.activeConfigId = savedActiveConfig;
    }

    // Rebuild merged tree from loaded config trees
    const mergedTree = this.buildMergedTree();
    const savedRun = storage.get<TestRunResult>(STORAGE_KEY_LAST_RUN);

    this.setState({
      tree: mergedTree,
      ...(savedRun ? { lastRun: savedRun } : {}),
    });
  }

  getState(): TestRunnerState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(partial: Partial<TestRunnerState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((l) => l(this.state));
  }

  private async persist() {
    if (!this.storage) return;
    await this.storage.set(STORAGE_KEY_TREE, this.state.tree);
    if (this.state.lastRun) {
      await this.storage.set(STORAGE_KEY_LAST_RUN, this.state.lastRun);
    }
    // Persist per-config trees
    const obj: Record<string, TestNode[]> = {};
    for (const [id, nodes] of this.configTrees) {
      obj[id] = nodes;
    }
    await this.storage.set(STORAGE_KEY_CONFIG_TREES, obj);
    await this.storage.set(STORAGE_KEY_ACTIVE_CONFIG, this.state.activeConfigId);
  }

  // ---------------------------------------------------------------------------
  // Config management
  // ---------------------------------------------------------------------------

  getConfigs(): TestConfig[] {
    return this.state.configs;
  }

  getActiveConfig(): TestConfig | undefined {
    return this.state.configs.find(c => c.id === this.state.activeConfigId);
  }

  getConfigById(id: string): TestConfig | undefined {
    return this.state.configs.find(c => c.id === id);
  }

  setActiveConfig(configId: string) {
    if (this.state.configs.some(c => c.id === configId)) {
      this.setState({ activeConfigId: configId });
      this.persist();
    }
  }

  addConfig(config: TestConfig) {
    if (this.state.configs.some(c => c.id === config.id)) return;
    this.setState({ configs: [...this.state.configs, config] });
    if (this.storage) {
      this.storage.set(STORAGE_KEY_CONFIGS, this.state.configs);
    }
  }

  removeConfig(configId: string) {
    this.setState({
      configs: this.state.configs.filter(c => c.id !== configId),
    });
    this.configTrees.delete(configId);
    this.setState({ tree: this.buildMergedTree() });
    this.persist();
  }

  // ---------------------------------------------------------------------------
  // Discovery & run
  // ---------------------------------------------------------------------------

  /**
   * Parse the JSON output from `npx playwright test --list --reporter=json`.
   * Stores results under the specified config (or active config).
   */
  parseDiscoveryOutput(jsonOutput: string, configId?: string): TestNode[] {
    const id = configId ?? this.state.activeConfigId;
    try {
      const parsed = JSON.parse(jsonOutput) as PlaywrightListOutput;
      const configTree = this.parseSuites(parsed.suites);
      this.configTrees.set(id, configTree);
      const mergedTree = this.buildMergedTree();
      this.setState({ tree: mergedTree, error: null });
      this.persist();
      return configTree;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState({ error: `Failed to parse test list: ${msg}` });
      return [];
    }
  }

  /**
   * Parse the JSON output from `npx playwright test --reporter=json`.
   * Stores results under the specified config (or active config).
   */
  parseRunOutput(jsonOutput: string, configId?: string): TestRunResult | null {
    const id = configId ?? this.state.activeConfigId;
    const config = this.getConfigById(id);
    try {
      const parsed = JSON.parse(jsonOutput) as PlaywrightRunOutput;
      const resultTree = this.parseSuitesWithResults(parsed.suites);

      const result: TestRunResult = {
        timestamp: Date.now(),
        configPath: config?.configPath ?? id,
        totalTests: parsed.stats.expected + parsed.stats.unexpected + parsed.stats.skipped + parsed.stats.flaky,
        passed: parsed.stats.expected,
        failed: parsed.stats.unexpected,
        skipped: parsed.stats.skipped,
        flaky: parsed.stats.flaky,
        durationMs: parsed.stats.duration,
        tree: resultTree,
      };

      this.configTrees.set(id, resultTree);
      const mergedTree = this.buildMergedTree();
      this.setState({ tree: mergedTree, lastRun: result, isRunning: false, error: null });
      this.persist();
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState({ isRunning: false, error: `Failed to parse test results: ${msg}` });
      return null;
    }
  }

  /** Mark the runner as currently running (for UI state) */
  setRunning(running: boolean) {
    this.setState({ isRunning: running });
  }

  /** Set an error message */
  setError(error: string | null) {
    this.setState({ error });
  }

  /** Get the command string for discovering tests for a specific config */
  getDiscoverCommand(configId?: string): string {
    const config = this.getConfigById(configId ?? this.state.activeConfigId);
    const configPath = config?.configPath ?? 'playwright.config.ts';
    const parts = ['npx playwright test --list --reporter=json'];
    if (configPath !== 'playwright.config.ts') {
      parts.push(`--config ${configPath}`);
    }
    return this.wrapWithEnv(parts.join(' '), config?.env);
  }

  /** Get the command string for running tests for a specific config */
  getRunCommand(scope?: string, outputDir?: string, configId?: string): string {
    const config = this.getConfigById(configId ?? this.state.activeConfigId);
    const configPath = config?.configPath ?? 'playwright.config.ts';
    const parts = ['npx playwright test --reporter=json'];
    if (configPath !== 'playwright.config.ts') {
      parts.push(`--config ${configPath}`);
    }
    if (outputDir) {
      parts.push(`--output ${outputDir}`);
    }
    if (scope) {
      parts.push(scope);
    }
    return this.wrapWithEnv(parts.join(' '), config?.env);
  }

  /** Get env vars for host.exec() for a specific config */
  getExecEnv(configId?: string): Record<string, string> | undefined {
    const config = this.getConfigById(configId ?? this.state.activeConfigId);
    return config?.env;
  }

  // ---------------------------------------------------------------------------
  // Tree merging
  // ---------------------------------------------------------------------------

  /**
   * Build a merged tree from all config trees.
   * If only one config has tests, return its tree directly (with configId stamped).
   * If multiple configs have tests, wrap each in a config-group node.
   */
  private buildMergedTree(): TestNode[] {
    const populated = [...this.configTrees.entries()].filter(([, nodes]) => nodes.length > 0);

    if (populated.length === 0) return [];
    if (populated.length === 1) {
      return this.stampConfigId(populated[0][1], populated[0][0]);
    }

    // Multiple configs — wrap each in a group node
    return populated.map(([configId, nodes]) => {
      const config = this.getConfigById(configId);
      const label = config?.label ?? configId;
      const stamped = this.stampConfigId(nodes, configId);
      const statuses = this.collectStatuses(stamped);
      return {
        id: `config:${configId}`,
        type: 'project' as const,
        name: label,
        children: stamped,
        status: this.computeGroupStatus(statuses),
        configId,
      };
    });
  }

  /** Recursively set configId on all nodes in the tree */
  private stampConfigId(nodes: TestNode[], configId: string): TestNode[] {
    return nodes.map(node => ({
      ...node,
      configId,
      children: this.stampConfigId(node.children, configId),
    }));
  }

  private collectStatuses(nodes: TestNode[]): TestStatus[] {
    const statuses: TestStatus[] = [];
    for (const node of nodes) {
      if (node.type === 'test') {
        statuses.push(node.status);
      } else {
        statuses.push(...this.collectStatuses(node.children));
      }
    }
    return statuses;
  }

  private computeGroupStatus(statuses: TestStatus[]): TestStatus {
    if (statuses.length === 0) return 'pending';
    if (statuses.includes('failed')) return 'failed';
    if (statuses.includes('flaky')) return 'flaky';
    if (statuses.includes('running')) return 'running';
    if (statuses.every(s => s === 'passed')) return 'passed';
    if (statuses.every(s => s === 'skipped')) return 'skipped';
    if (statuses.some(s => s === 'passed')) return 'passed';
    return 'pending';
  }

  // ---------------------------------------------------------------------------
  // Playwright JSON parsing
  // ---------------------------------------------------------------------------

  private parseSuites(suites: PlaywrightSuite[]): TestNode[] {
    return suites.map((suite) => this.parseSuite(suite, []));
  }

  private parseSuite(suite: PlaywrightSuite, parentPath: string[]): TestNode {
    const path = [...parentPath, suite.title];
    const id = path.join(' > ');

    const children: TestNode[] = [];

    if (suite.suites) {
      for (const child of suite.suites) {
        children.push(this.parseSuite(child, path));
      }
    }

    if (suite.specs) {
      for (const spec of suite.specs) {
        children.push({
          id: [...path, spec.title].join(' > '),
          type: 'test',
          name: spec.title,
          filePath: spec.file,
          line: spec.line,
          column: spec.column,
          children: [],
          status: 'pending',
        });
      }
    }

    const type: TestNode['type'] = suite.file && parentPath.length === 0 ? 'file'
      : parentPath.length === 0 ? 'project'
      : 'describe';

    return {
      id,
      type,
      name: suite.title,
      filePath: suite.file,
      line: suite.line,
      column: suite.column,
      children,
      status: 'pending',
    };
  }

  private parseSuitesWithResults(suites: PlaywrightSuite[]): TestNode[] {
    return suites.map((suite) => this.parseSuiteWithResults(suite, []));
  }

  private parseSuiteWithResults(suite: PlaywrightSuite, parentPath: string[]): TestNode {
    const path = [...parentPath, suite.title];
    const id = path.join(' > ');

    const children: TestNode[] = [];

    if (suite.suites) {
      for (const child of suite.suites) {
        children.push(this.parseSuiteWithResults(child, path));
      }
    }

    if (suite.specs) {
      for (const spec of suite.specs) {
        const lastResult = spec.tests?.[0]?.results?.[spec.tests[0].results.length - 1];
        const status = this.mapStatus(lastResult?.status);
        const screenshot = lastResult?.attachments?.find(
          (a) => a.contentType.startsWith('image/') && a.path
        );
        const trace = lastResult?.attachments?.find(
          (a) => (a.name === 'trace' || a.contentType === 'application/zip') && a.path?.endsWith('.zip')
        );

        children.push({
          id: [...path, spec.title].join(' > '),
          type: 'test',
          name: spec.title,
          filePath: spec.file,
          line: spec.line,
          column: spec.column,
          children: [],
          status,
          duration: lastResult?.duration,
          error: lastResult?.error ? {
            message: lastResult.error.message,
            stack: lastResult.error.stack,
            screenshotPath: screenshot?.path,
            tracePath: trace?.path,
          } : undefined,
          retries: spec.tests?.[0]?.results ? spec.tests[0].results.length - 1 : 0,
        });
      }
    }

    const statuses = children.map((c) => c.status);
    let computedStatus: TestStatus = 'pending';
    if (statuses.includes('failed')) computedStatus = 'failed';
    else if (statuses.includes('flaky')) computedStatus = 'flaky';
    else if (statuses.includes('running')) computedStatus = 'running';
    else if (statuses.every((s) => s === 'passed')) computedStatus = 'passed';
    else if (statuses.every((s) => s === 'skipped')) computedStatus = 'skipped';
    else if (statuses.some((s) => s === 'passed')) computedStatus = 'passed';

    const type: TestNode['type'] = suite.file && parentPath.length === 0 ? 'file'
      : parentPath.length === 0 ? 'project'
      : 'describe';

    return {
      id,
      type,
      name: suite.title,
      filePath: suite.file,
      line: suite.line,
      column: suite.column,
      children,
      status: computedStatus,
    };
  }

  private mapStatus(status?: string): TestStatus {
    switch (status) {
      case 'passed': case 'expected': return 'passed';
      case 'failed': case 'unexpected': return 'failed';
      case 'skipped': return 'skipped';
      case 'flaky': return 'flaky';
      default: return 'pending';
    }
  }

  /** Prefix a command with env var assignments if needed (for display/shell) */
  private wrapWithEnv(cmd: string, env?: Record<string, string>): string {
    if (!env || Object.keys(env).length === 0) return cmd;
    const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    return `${envPrefix} ${cmd}`;
  }
}

/** Singleton registry for sharing runner between panel and AI tools */
let activeRunner: TestRunner | null = null;

export function getRunner(): TestRunner | null {
  return activeRunner;
}

export function setRunner(runner: TestRunner) {
  activeRunner = runner;
}
