import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import type { TraceData, TraceAction, TestNode } from '../types';
import { parseTrace, revokeTraceUrls } from '../traceParser';
import { getRunner } from '../testRunner';

interface TraceViewerProps {
  host: PanelHostProps['host'];
  /** Pre-selected trace file path (e.g., from clicking a failed test) */
  tracePath?: string;
}

interface TraceEntry {
  path: string;
  label: string;
  source: 'results' | 'filesystem';
}

export function TraceViewer({ host, tracePath }: TraceViewerProps) {
  const [traceData, setTraceData] = useState<TraceData | null>(null);
  const [selectedAction, setSelectedAction] = useState<TraceAction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableTraces, setAvailableTraces] = useState<TraceEntry[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(tracePath ?? null);
  const prevTraceRef = useRef<TraceData | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Discover available trace files
  useEffect(() => {
    discoverTraces();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load trace when path changes
  useEffect(() => {
    if (selectedTrace) {
      loadTrace(selectedTrace);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrace]);

  // Update if parent provides a new tracePath
  useEffect(() => {
    if (tracePath && tracePath !== selectedTrace) {
      setSelectedTrace(tracePath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracePath]);

  async function discoverTraces() {
    const traces: TraceEntry[] = [];
    const seenPaths = new Set<string>();

    // 1. Extract trace paths from last test run results
    const runner = getRunner();
    if (runner) {
      const state = runner.getState();
      collectTracesFromTree(state.tree, traces, seenPaths);
    }

    // 2. Search common output directories for trace ZIPs
    const searchDirs = [
      'e2e_test_output/test-results',
      'test-results',
      'playwright-report',
    ];

    for (const dir of searchDirs) {
      try {
        const result = await host.exec(
          `find "${dir}" -name "trace.zip" -o -name "*.trace.zip" 2>/dev/null | head -30`,
          { timeout: 5000 }
        );
        if (result.success && result.stdout) {
          for (const p of result.stdout.split('\n')) {
            const trimmed = p.trim();
            if (trimmed && !seenPaths.has(trimmed)) {
              seenPaths.add(trimmed);
              // Extract a meaningful label from the path
              // e.g., "test-results/my-test-chromium/trace.zip" -> "my-test-chromium"
              const parts = trimmed.split('/');
              const label = parts.length >= 2 ? parts[parts.length - 2] : trimmed;
              traces.push({ path: trimmed, label, source: 'filesystem' });
            }
          }
        }
      } catch {
        // Non-critical
      }
    }

    setAvailableTraces(traces);

    // Auto-select if we have traces and nothing selected
    if (traces.length > 0 && !selectedTrace) {
      setSelectedTrace(traces[0].path);
    }
  }

  async function loadTrace(path: string) {
    setLoading(true);
    setError(null);
    setSelectedAction(null);

    // Clean up previous trace blob URLs
    if (prevTraceRef.current) {
      revokeTraceUrls(prevTraceRef.current);
    }

    try {
      // Read the trace file via host.exec (cat as base64)
      const fullPath = path.startsWith('/') ? path : `${host.workspacePath}/${path}`;
      const result = await host.exec(`base64 < "${fullPath}"`, { timeout: 30000 });
      if (!result.success || !result.stdout) {
        throw new Error(result.stderr || 'Failed to read trace file');
      }

      // Decode base64 to ArrayBuffer
      const binaryStr = atob(result.stdout.replace(/\s/g, ''));
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const data = await parseTrace(bytes.buffer);
      setTraceData(data);
      prevTraceRef.current = data;
      if (data.actions.length > 0) {
        setSelectedAction(data.actions[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse trace');
      setTraceData(null);
    } finally {
      setLoading(false);
    }
  }

  const handleSelectAction = useCallback((action: TraceAction) => {
    setSelectedAction(action);
  }, []);

  const handleRefresh = useCallback(() => {
    discoverTraces();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      if (prevTraceRef.current) {
        revokeTraceUrls(prevTraceRef.current);
      }
    };
  }, []);

  if (loading) {
    return (
      <div className="pw-trace-loading">
        <span
          className="material-symbols-outlined"
          style={{ fontSize: 32, color: '#60a5fa', animation: 'spin 1s linear infinite' }}
        >
          progress_activity
        </span>
        <p>Loading trace...</p>
      </div>
    );
  }

  if (!traceData && !error) {
    return (
      <div className="pw-trace-empty">
        {availableTraces.length > 0 ? (
          <>
            <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#666' }}>
              timeline
            </span>
            <p>Select a trace file</p>
            <div className="pw-trace-file-list">
              {availableTraces.map((entry) => (
                <button
                  key={entry.path}
                  className="pw-trace-file-btn"
                  onClick={() => setSelectedTrace(entry.path)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                    {entry.source === 'results' ? 'bug_report' : 'description'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{entry.label}</div>
                    <div style={{ fontSize: 10, color: '#808080', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.path}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#666' }}>
              timeline
            </span>
            <p>No trace files found</p>
            <p className="pw-hint">
              Traces are generated when tests fail with tracing enabled.
              <br />
              Check your playwright.config.ts: <code>trace: 'on-first-retry'</code> or <code>'retain-on-failure'</code>
            </p>
            <button className="pw-trace-file-btn" style={{ marginTop: 12, maxWidth: 200 }} onClick={handleRefresh}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
              <span>Refresh</span>
            </button>
          </>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="pw-trace-empty">
        <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#ef4444' }}>
          error
        </span>
        <p>{error}</p>
        <button className="pw-trace-file-btn" style={{ marginTop: 8, maxWidth: 200 }} onClick={handleRefresh}>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
          <span>Try again</span>
        </button>
      </div>
    );
  }

  const selectedScreenshot =
    selectedAction?.screenshotIndex != null
      ? traceData!.screenshots[selectedAction.screenshotIndex]
      : null;

  const selectedSnapshot =
    selectedAction?.snapshotIndex != null
      ? traceData!.snapshots[selectedAction.snapshotIndex]
      : null;

  return (
    <div className="pw-trace-viewer">
      {/* Trace file selector bar */}
      <div className="pw-trace-header">
        <select
          className="pw-trace-select"
          value={selectedTrace ?? ''}
          onChange={(e) => setSelectedTrace(e.target.value)}
        >
          {availableTraces.map((entry) => (
            <option key={entry.path} value={entry.path}>
              {entry.label} ({entry.path})
            </option>
          ))}
        </select>
        <button className="pw-icon-btn" onClick={handleRefresh} title="Refresh trace list">
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>refresh</span>
        </button>
        <span className="pw-trace-test-name">{traceData!.testName}</span>
        {traceData!.error && (
          <span className="pw-trace-error-badge">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>error</span>
            Failed
          </span>
        )}
        {traceData!.isElectron && (
          <span className="pw-trace-electron-badge">Electron</span>
        )}
      </div>

      {/* Electron warning */}
      {traceData!.isElectron && traceData!.snapshots.length > 0 && (
        <div className="pw-trace-electron-warning">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>warning</span>
          DOM snapshots may appear garbled for Electron apps (known Playwright limitation)
        </div>
      )}

      {/* Main content: action timeline left, detail right */}
      <div className="pw-trace-content">
        {/* Left: Action timeline */}
        <div className="pw-trace-timeline">
          {traceData!.actions.length === 0 && (
            <div className="pw-trace-no-detail" style={{ padding: 24 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 24, color: '#666' }}>
                info
              </span>
              <p>No actions found in this trace</p>
            </div>
          )}
          {traceData!.actions.map((action) => (
            <div
              key={action.actionId}
              className={`pw-trace-action ${
                selectedAction?.actionId === action.actionId ? 'pw-trace-action-selected' : ''
              } ${action.error ? 'pw-trace-action-error' : ''}`}
              onClick={() => handleSelectAction(action)}
            >
              <div className="pw-trace-action-icon">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                  {getActionIcon(action.type)}
                </span>
              </div>
              <div className="pw-trace-action-info">
                <div className="pw-trace-action-title">{action.title}</div>
                <div className="pw-trace-action-meta">
                  <span>{action.type}</span>
                  <span>{formatDuration(action.duration)}</span>
                </div>
              </div>
              {action.error && (
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 14, color: '#ef4444', flexShrink: 0 }}
                >
                  error
                </span>
              )}
              {action.screenshotIndex != null && (
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 14, color: '#808080', flexShrink: 0 }}
                >
                  photo_camera
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Right: Detail pane */}
        <div className="pw-trace-detail">
          {selectedAction ? (
            <div className="pw-trace-detail-content">
              {/* Action header */}
              <div className="pw-trace-detail-header">
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                  {getActionIcon(selectedAction.type)}
                </span>
                <div>
                  <div className="pw-trace-detail-title">{selectedAction.title}</div>
                  <div className="pw-trace-detail-meta">
                    {selectedAction.type} -- {formatDuration(selectedAction.duration)}
                    {selectedAction.location && (
                      <span className="pw-trace-location">
                        {selectedAction.location.file}:{selectedAction.location.line}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Error message */}
              {selectedAction.error && (
                <div className="pw-trace-detail-error">
                  <div className="pw-section-label">Error</div>
                  <pre className="pw-trace-error-text">{selectedAction.error}</pre>
                </div>
              )}

              {/* Screenshot */}
              {selectedScreenshot && (
                <div className="pw-trace-detail-screenshot">
                  <div className="pw-section-label">Screenshot</div>
                  <img
                    src={selectedScreenshot.blobUrl}
                    alt="Action screenshot"
                    className="pw-trace-screenshot-img"
                  />
                </div>
              )}

              {/* DOM Snapshot */}
              {selectedSnapshot && (
                <div className="pw-trace-detail-snapshot">
                  <div className="pw-section-label">
                    DOM Snapshot
                    {traceData!.isElectron && (
                      <span className="pw-trace-snapshot-warning"> (may be garbled)</span>
                    )}
                  </div>
                  <iframe
                    ref={iframeRef}
                    srcDoc={selectedSnapshot.html}
                    className="pw-trace-snapshot-frame"
                    sandbox="allow-same-origin"
                    title="DOM Snapshot"
                  />
                </div>
              )}

              {/* No visual content */}
              {!selectedScreenshot && !selectedSnapshot && !selectedAction.error && (
                <div className="pw-trace-no-detail">
                  <span className="material-symbols-outlined" style={{ fontSize: 24, color: '#666' }}>
                    info
                  </span>
                  <p>No screenshots or snapshots for this action</p>
                </div>
              )}
            </div>
          ) : (
            <div className="pw-trace-no-detail">
              <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#4a4a4a' }}>
                timeline
              </span>
              <p>Select an action to view details</p>
            </div>
          )}
        </div>
      </div>

      {/* Screenshot filmstrip */}
      {traceData!.screenshots.length > 0 && (
        <div className="pw-trace-filmstrip">
          {traceData!.screenshots.map((screenshot, i) => (
            <img
              key={i}
              src={screenshot.blobUrl}
              alt={`Screenshot ${i + 1}`}
              className={`pw-trace-filmstrip-thumb ${
                selectedScreenshot?.blobUrl === screenshot.blobUrl
                  ? 'pw-trace-filmstrip-active'
                  : ''
              }`}
              onClick={() => {
                // Find the action associated with this screenshot
                const action = traceData!.actions.find(
                  (a) => a.screenshotIndex === i
                );
                if (action) handleSelectAction(action);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Collect trace paths from test results tree */
function collectTracesFromTree(nodes: TestNode[], traces: TraceEntry[], seen: Set<string>) {
  for (const node of nodes) {
    if (node.type === 'test' && node.error?.tracePath) {
      const path = node.error.tracePath;
      if (!seen.has(path)) {
        seen.add(path);
        traces.push({ path, label: node.name, source: 'results' });
      }
    }
    collectTracesFromTree(node.children, traces, seen);
  }
}

function getActionIcon(type: string): string {
  if (type.includes('click') || type.includes('tap')) return 'touch_app';
  if (type.includes('fill') || type.includes('type') || type.includes('press')) return 'keyboard';
  if (type.includes('navigate') || type.includes('goto')) return 'open_in_browser';
  if (type.includes('wait') || type.includes('expect')) return 'hourglass_empty';
  if (type.includes('screenshot')) return 'photo_camera';
  if (type.includes('evaluate')) return 'code';
  if (type.includes('selector') || type.includes('locator')) return 'search';
  if (type.includes('launch')) return 'rocket_launch';
  return 'play_arrow';
}

function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
