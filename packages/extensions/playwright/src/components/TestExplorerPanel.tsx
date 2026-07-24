import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import type { TestConfig, TestNode } from '../types';
import { TestRunner, setRunner } from '../testRunner';
import { HistoryStore, setHistoryStore } from '../historyStore';
import { TestTreeNode } from './TestTreeNode';
import { ErrorDetail } from './ErrorDetail';
import { SummaryBar } from './SummaryBar';
import { TabBar, type TabId } from './TabBar';
import { TraceViewer } from './TraceViewer';
import { HistoryPanel } from './HistoryPanel';

const DEFAULT_E2E_CONFIG: TestConfig = {
  id: 'e2e',
  label: 'E2E Tests',
  configPath: 'playwright.config.ts',
};

const EXTENSION_TEST_CONFIG: TestConfig = {
  id: 'extensions',
  label: 'Extension Tests',
  configPath: 'packages/electron/playwright-extension.config.ts',
};

/**
 * Scan for extension test spec files to determine if the extension config
 * should be auto-added. Uses host.exec to glob for spec files.
 */
async function detectExtensionTests(host: PanelHostProps['host']): Promise<TestConfig[]> {
  try {
    const result = await host.exec(
      'find packages/extensions -path "*/tests/*.spec.ts" -maxdepth 4 2>/dev/null | head -20',
      { timeout: 5000 },
    );
    if (result.success && result.stdout.trim()) {
      // Found extension tests — build per-extension configs with NIMBALYST_EXT_TEST_DIR
      const lines = result.stdout.trim().split('\n');
      const testDirs = new Set<string>();
      for (const line of lines) {
        // e.g. packages/extensions/csv-spreadsheet/tests/csv-editor.spec.ts -> packages/extensions/csv-spreadsheet/tests
        const dir = line.substring(0, line.lastIndexOf('/'));
        testDirs.add(dir);
      }

      // Create one config per extension that has tests
      // NIMBALYST_EXT_TEST_DIR must be absolute — the playwright config resolves
      // it relative to its own directory (packages/electron/), not workspace root.
      const configs: TestConfig[] = [];
      for (const dir of testDirs) {
        // Extract extension name: packages/extensions/<name>/tests
        const parts = dir.split('/');
        const extIdx = parts.indexOf('extensions');
        const extName = extIdx >= 0 ? parts[extIdx + 1] : dir;
        const absoluteDir = dir.startsWith('/') ? dir : `${host.workspacePath}/${dir}`;
        configs.push({
          id: `ext-${extName}`,
          label: `${extName}`,
          configPath: EXTENSION_TEST_CONFIG.configPath,
          env: { NIMBALYST_EXT_TEST_DIR: absoluteDir },
        });
      }
      return configs;
    }
  } catch {
    // Silently ignore — no extension tests found
  }
  return [];
}

export function TestExplorerPanel({ host }: PanelHostProps) {
  const runnerRef = useRef<TestRunner | null>(null);
  const historyStoreRef = useRef<HistoryStore | null>(null);
  const [tree, setTree] = useState<TestNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<TestNode | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [lastRun, setLastRun] = useState<{ passed: number; failed: number; skipped: number; flaky: number; durationMs: number } | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('tests');
  const [tracePath, setTracePath] = useState<string | undefined>();
  const [, setFailedCount] = useState(0);
  const [configs, setConfigs] = useState<TestConfig[]>([]);
  const [activeConfigId, setActiveConfigId] = useState('e2e');

  // Initialize runner and history store
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Detect extension tests
      const extConfigs = await detectExtensionTests(host);
      const allConfigs = [DEFAULT_E2E_CONFIG, ...extConfigs];

      if (cancelled) return;

      // Restore saved active config or use first
      const savedActiveConfig = host.storage.get<string>('activeConfigId');
      const initialActiveId = savedActiveConfig && allConfigs.some(c => c.id === savedActiveConfig)
        ? savedActiveConfig
        : allConfigs[0].id;

      const runner = new TestRunner(host.workspacePath, allConfigs);
      runnerRef.current = runner;
      setRunner(runner);
      setConfigs(allConfigs);
      setActiveConfigId(initialActiveId);
      runner.setActiveConfig(initialActiveId);

      const historyStore = new HistoryStore();
      historyStoreRef.current = historyStore;
      setHistoryStore(historyStore);

      const unsub = runner.subscribe((state) => {
        setTree(state.tree);
        setIsRunning(state.isRunning);
        setError(state.error);
        setConfigs(state.configs);
        setActiveConfigId(state.activeConfigId);
        if (state.lastRun) {
          setLastRun({
            passed: state.lastRun.passed,
            failed: state.lastRun.failed,
            skipped: state.lastRun.skipped,
            flaky: state.lastRun.flaky,
            durationMs: state.lastRun.durationMs,
          });
          setFailedCount(state.lastRun.failed);
          historyStore.recordRun(state.lastRun);
        }
      });

      // Load persisted state from storage
      await runner.connectStorage(host.storage);
      historyStore.connectStorage(host.storage);

      // Auto-discover tests for all configs
      if (!cancelled) {
        await discoverAllConfigs(runner, allConfigs);
      }

      return unsub;
    }

    let unsub: (() => void) | undefined;
    init().then(u => { unsub = u; });

    return () => {
      cancelled = true;
      unsub?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.workspacePath]);

  async function discoverAllConfigs(runner: TestRunner, cfgs: TestConfig[]) {
    setIsDiscovering(true);
    setError(null);
    try {
      // Discover tests for each config in sequence to avoid overwhelming the system
      for (const config of cfgs) {
        const cmd = runner.getDiscoverCommand(config.id);
        const env = runner.getExecEnv(config.id);
        try {
          const result = await host.exec(cmd, { timeout: 30000, env });
          const output = result.stdout || result.stderr;
          if (output && output.includes('"suites"')) {
            runner.parseDiscoveryOutput(output, config.id);
          }
          // Silently skip configs that fail discovery (e.g. CDP not running)
        } catch {
          // Individual config discovery failure is non-fatal
        }
      }
    } finally {
      setIsDiscovering(false);
    }
  }

  async function discoverTests(runner: TestRunner, configId?: string) {
    setIsDiscovering(true);
    setError(null);
    try {
      const id = configId ?? runner.getState().activeConfigId;
      const cmd = runner.getDiscoverCommand(id);
      const env = runner.getExecEnv(id);
      const result = await host.exec(cmd, { timeout: 30000, env });
      const output = result.stdout || result.stderr;
      if (output && output.includes('"suites"')) {
        runner.parseDiscoveryOutput(output, id);
      } else if (!result.success) {
        runner.setError(result.stderr || 'Test discovery failed');
      }
    } catch (e) {
      runner.setError(e instanceof Error ? e.message : 'Test discovery failed');
    } finally {
      setIsDiscovering(false);
    }
  }

  async function runTests(scope?: string) {
    const runner = runnerRef.current;
    if (!runner || isRunning) return;

    runner.setRunning(true);
    try {
      const configId = runner.getState().activeConfigId;
      const env = runner.getExecEnv(configId);
      const outputDir = await host.files.getBasePath();
      const cmd = runner.getRunCommand(scope, `${outputDir}/test-results`, configId);
      const result = await host.exec(cmd, { timeout: 300000, env });
      const output = result.stdout || result.stderr;
      if (output && output.includes('"stats"')) {
        runner.parseRunOutput(output, configId);
      } else {
        runner.setRunning(false);
        runner.setError(result.stderr || 'Test run failed');
      }
    } catch (e) {
      runner.setRunning(false);
      runner.setError(e instanceof Error ? e.message : 'Test run failed');
    }
  }

  // Update AI context when state changes
  useEffect(() => {
    host.ai?.setContext({
      testCount: countTests(tree),
      isRunning,
      lastRun,
      configs: configs.map(c => ({ id: c.id, label: c.label })),
      activeConfig: activeConfigId,
      historyRuns: historyStoreRef.current?.getHistory().runs.length ?? 0,
    });
  }, [tree, isRunning, lastRun, configs, activeConfigId, host.ai]);

  const handleRun = useCallback((node: TestNode) => {
    const scope = node.filePath || undefined;
    // Switch to the node's config before running so the correct config/env is used
    if (node.configId) {
      runnerRef.current?.setActiveConfig(node.configId);
    }
    runTests(scope);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  const handleRunAll = useCallback(() => {
    runTests();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  const handleRefresh = useCallback(() => {
    const runner = runnerRef.current;
    if (runner) discoverTests(runner);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefreshAll = useCallback(() => {
    const runner = runnerRef.current;
    if (runner) discoverAllConfigs(runner, runner.getConfigs());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfigChange = useCallback((configId: string) => {
    const runner = runnerRef.current;
    if (runner) {
      runner.setActiveConfig(configId);
    }
  }, []);

  const handleSelect = useCallback((node: TestNode) => {
    setSelectedNode(node);
  }, []);

  const handleOpenFile = useCallback((filePath: string, _line?: number) => {
    const fullPath = filePath.startsWith('/')
      ? filePath
      : `${host.workspacePath}/${filePath}`;
    host.openFile(fullPath);
  }, [host]);

  const handleViewTrace = useCallback((path: string) => {
    setTracePath(path);
    setActiveTab('traces');
  }, []);

  // Filter tree by search query
  const filteredTree = searchQuery ? filterTree(tree, searchQuery.toLowerCase()) : tree;

  const tabs = [
    { id: 'tests' as const, label: 'Tests', icon: 'science' },
    { id: 'traces' as const, label: 'Traces', icon: 'timeline' },
    {
      id: 'history' as const,
      label: 'History',
      icon: 'analytics',
      badge: historyStoreRef.current?.getHistory().runs.length,
    },
  ];

  const showConfigSelector = configs.length > 1;

  return (
    <div className="pw-panel">
      {/* Toolbar */}
      <div className="pw-toolbar">
        <div className="pw-toolbar-left">
          <span className="pw-toolbar-title">Playwright</span>
          {activeTab === 'tests' && (
            <>
              {!isRunning ? (
                <button className="pw-icon-btn pw-run-all" onClick={handleRunAll} title="Run all tests">
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                    play_arrow
                  </span>
                </button>
              ) : (
                <span className="pw-running-indicator">
                  <span
                    className="material-symbols-outlined"
                    style={{ fontSize: 14, animation: 'spin 1s linear infinite', color: '#60a5fa' }}
                  >
                    progress_activity
                  </span>
                  <span style={{ fontSize: 11, color: '#60a5fa' }}>Running...</span>
                </span>
              )}
              <button
                className="pw-icon-btn"
                onClick={showConfigSelector ? handleRefreshAll : handleRefresh}
                disabled={isDiscovering}
                title={showConfigSelector ? 'Refresh all test configs' : 'Refresh test list'}
              >
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 18,
                    animation: isDiscovering ? 'spin 1s linear infinite' : undefined,
                  }}
                >
                  refresh
                </span>
              </button>
            </>
          )}
        </div>
        {activeTab === 'tests' && (
          <div className="pw-toolbar-right">
            {showConfigSelector && (
              <select
                className="pw-config-select"
                value={activeConfigId}
                onChange={(e) => handleConfigChange(e.target.value)}
                title="Select test config for running tests"
              >
                {configs.map(c => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            )}
            <input
              type="text"
              className="pw-search-input"
              placeholder="Filter tests..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        )}
        {lastRun && activeTab === 'tests' && (
          <div className="pw-toolbar-summary">
            <SummaryBar {...lastRun} />
          </div>
        )}
      </div>

      {/* Tab bar */}
      <TabBar tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Error banner */}
      {error && activeTab === 'tests' && (
        <div className="pw-error-banner">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>error</span>
          <span>{error}</span>
        </div>
      )}

      {/* Tab content */}
      {activeTab === 'tests' && (
        <div className="pw-content">
          {/* Left: Test tree */}
          <div className="pw-tree-pane">
            {filteredTree.length === 0 && !isDiscovering && !error && (
              <div className="pw-empty-state">
                <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#666' }}>
                  science
                </span>
                <p>No Playwright tests found</p>
                <p className="pw-hint">
                  Make sure playwright.config.ts exists in your workspace
                </p>
              </div>
            )}
            {isDiscovering && filteredTree.length === 0 && (
              <div className="pw-empty-state">
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 32, color: '#60a5fa', animation: 'spin 1s linear infinite' }}
                >
                  progress_activity
                </span>
                <p>Discovering tests...</p>
              </div>
            )}
            {filteredTree.map((node) => (
              <TestTreeNode
                key={node.id}
                node={node}
                depth={0}
                onRun={handleRun}
                onSelect={handleSelect}
                selectedId={selectedNode?.id ?? null}
                onOpenFile={handleOpenFile}
              />
            ))}
          </div>

          {/* Right: Detail pane */}
          <div className="pw-detail-pane">
            {selectedNode ? (
              <ErrorDetail
                node={selectedNode}
                onOpenFile={handleOpenFile}
                onViewTrace={handleViewTrace}
              />
            ) : (
              <div className="pw-detail-placeholder">
                <span className="material-symbols-outlined" style={{ fontSize: 40, color: '#4a4a4a' }}>
                  science
                </span>
                <p>Select a test to view details</p>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'traces' && (
        <TraceViewer host={host} tracePath={tracePath} />
      )}

      {activeTab === 'history' && historyStoreRef.current && (
        <HistoryPanel store={historyStoreRef.current} onOpenFile={handleOpenFile} />
      )}
    </div>
  );
}

function countTests(tree: TestNode[]): number {
  let count = 0;
  for (const node of tree) {
    if (node.type === 'test') count++;
    count += countTests(node.children);
  }
  return count;
}

function filterTree(tree: TestNode[], query: string): TestNode[] {
  return tree
    .map((node) => {
      if (node.type === 'test') {
        return node.name.toLowerCase().includes(query) ? node : null;
      }
      const filteredChildren = filterTree(node.children, query);
      if (filteredChildren.length > 0 || node.name.toLowerCase().includes(query)) {
        return { ...node, children: filteredChildren };
      }
      return null;
    })
    .filter((n): n is TestNode => n !== null);
}
