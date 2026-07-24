import { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { RunHistory, FlakyTestScore } from '../types';
import { HistoryStore } from '../historyStore';

interface HistoryPanelProps {
  store: HistoryStore;
  onOpenFile?: (filePath: string) => void;
}

export function HistoryPanel({ store, onOpenFile }: HistoryPanelProps) {
  const [history, setHistory] = useState<RunHistory>(store.getHistory());
  const [flakyTests, setFlakyTests] = useState<FlakyTestScore[]>([]);
  const [selectedRunIndex, setSelectedRunIndex] = useState<number | null>(null);

  useEffect(() => {
    const unsub = store.subscribe((h) => {
      setHistory(h);
      setFlakyTests(store.getFlakyTests());
    });
    // Initial load
    setFlakyTests(store.getFlakyTests());
    return unsub;
  }, [store]);

  if (history.runs.length === 0) {
    return (
      <div className="pw-history-empty">
        <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#666' }}>
          analytics
        </span>
        <p>No test run history yet</p>
        <p className="pw-hint">
          Run tests to start building analytics
        </p>
      </div>
    );
  }

  const trendData = store.getDurationTrend();
  const passfailData = trendData.map((d) => ({
    ...d,
    label: formatDate(d.timestamp),
  }));

  const selectedRun =
    selectedRunIndex != null ? history.runs[selectedRunIndex] : null;

  return (
    <div className="pw-history">
      {/* Pass/Fail Trend */}
      <div className="pw-history-section">
        <div className="pw-history-section-title">Pass / Fail Trend</div>
        <div className="pw-history-chart">
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={passfailData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#3a3a3a" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: '#808080' }}
                tickLine={false}
                axisLine={{ stroke: '#4a4a4a' }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#808080' }}
                tickLine={false}
                axisLine={{ stroke: '#4a4a4a' }}
              />
              <Tooltip
                contentStyle={{
                  background: '#1a1a1a',
                  border: '1px solid #4a4a4a',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="passed"
                stackId="1"
                fill="#4ade80"
                fillOpacity={0.4}
                stroke="#4ade80"
              />
              <Area
                type="monotone"
                dataKey="failed"
                stackId="1"
                fill="#ef4444"
                fillOpacity={0.4}
                stroke="#ef4444"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Duration Trend */}
      <div className="pw-history-section">
        <div className="pw-history-section-title">Duration Trend</div>
        <div className="pw-history-chart">
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={passfailData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#3a3a3a" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: '#808080' }}
                tickLine={false}
                axisLine={{ stroke: '#4a4a4a' }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#808080' }}
                tickLine={false}
                axisLine={{ stroke: '#4a4a4a' }}
                tickFormatter={(v: number) => formatDurationShort(v)}
              />
              <Tooltip
                contentStyle={{
                  background: '#1a1a1a',
                  border: '1px solid #4a4a4a',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(value) => [formatDuration(value as number), 'Duration']}
              />
              <Line
                type="monotone"
                dataKey="durationMs"
                stroke="#60a5fa"
                dot={{ r: 3, fill: '#60a5fa' }}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Flakiest Tests */}
      {flakyTests.length > 0 && (
        <div className="pw-history-section">
          <div className="pw-history-section-title">
            Flakiest Tests
            <span className="pw-history-section-subtitle">
              (failed in {'>'}1 run)
            </span>
          </div>
          <div className="pw-history-chart">
            <ResponsiveContainer width="100%" height={Math.min(flakyTests.length * 32 + 20, 200)}>
              <BarChart
                data={flakyTests.slice(0, 10)}
                layout="vertical"
                margin={{ left: 120 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#3a3a3a" horizontal={false} />
                <XAxis
                  type="number"
                  domain={[0, 1]}
                  tick={{ fontSize: 10, fill: '#808080' }}
                  tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                  axisLine={{ stroke: '#4a4a4a' }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 10, fill: '#b3b3b3' }}
                  tickLine={false}
                  axisLine={{ stroke: '#4a4a4a' }}
                  width={120}
                />
                <Tooltip
                  contentStyle={{
                    background: '#1a1a1a',
                    border: '1px solid #4a4a4a',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(value) => {
                    const v = value as number;
                    return [
                      `${Math.round(v * 100)}% (${flakyTests.find((t) => t.failureRate === v)?.failures ?? '?'} failures)`,
                      'Failure Rate',
                    ];
                  }}
                />
                <Bar dataKey="failureRate" radius={[0, 4, 4, 0]}>
                  {flakyTests.slice(0, 10).map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.failureRate > 0.5 ? '#ef4444' : entry.failureRate > 0.2 ? '#fbbf24' : '#60a5fa'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Run History Table */}
      <div className="pw-history-section pw-history-table-section">
        <div className="pw-history-section-title">Recent Runs</div>
        <div className="pw-history-table-container">
          <table className="pw-history-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Passed</th>
                <th>Failed</th>
                <th>Skipped</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.runs.map((run, i) => (
                <tr
                  key={run.id}
                  className={`pw-history-row ${selectedRunIndex === i ? 'pw-history-row-selected' : ''} ${run.failed > 0 ? 'pw-history-row-failed' : ''}`}
                  onClick={() => setSelectedRunIndex(selectedRunIndex === i ? null : i)}
                >
                  <td className="pw-history-cell-date">{formatDateTime(run.timestamp)}</td>
                  <td>
                    <span className="pw-stat">
                      <span className="pw-stat-dot" style={{ background: '#4ade80' }} />
                      {run.passed}
                    </span>
                  </td>
                  <td>
                    <span className="pw-stat">
                      <span className="pw-stat-dot" style={{ background: '#ef4444' }} />
                      {run.failed}
                    </span>
                  </td>
                  <td>
                    <span className="pw-stat">
                      <span className="pw-stat-dot" style={{ background: '#808080' }} />
                      {run.skipped}
                    </span>
                  </td>
                  <td className="pw-history-cell-duration">{formatDuration(run.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Run detail */}
        {selectedRun && (
          <div className="pw-history-run-detail">
            <div className="pw-section-label">
              Run details -- {formatDateTime(selectedRun.timestamp)}
            </div>
            <div className="pw-history-run-tests">
              {selectedRun.testResults
                .filter((t) => t.status === 'failed')
                .map((t) => (
                  <div
                    key={t.testId}
                    className="pw-history-test-item pw-history-test-failed"
                    onClick={() => t.filePath && onOpenFile?.(t.filePath)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#ef4444' }}>
                      close
                    </span>
                    <span>{t.name}</span>
                    <span className="pw-tree-duration">{formatDuration(t.durationMs)}</span>
                  </div>
                ))}
              {selectedRun.testResults
                .filter((t) => t.status === 'passed')
                .map((t) => (
                  <div key={t.testId} className="pw-history-test-item">
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#4ade80' }}>
                      check
                    </span>
                    <span>{t.name}</span>
                    <span className="pw-tree-duration">{formatDuration(t.durationMs)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}
