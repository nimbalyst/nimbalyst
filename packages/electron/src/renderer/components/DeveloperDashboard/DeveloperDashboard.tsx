import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { summarizeDatabaseQueryStats } from './dashboardStats';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = 'overview' | 'atomfamily';

interface AtomFamilyStat {
  name: string;
  count: number;
  file: string;
  params: string[];
}

interface WorkspaceWatcherInfo {
  workspacePath: string;
  subscriberCount: number;
  subscriberIds: string[];
}

interface SampleSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  totalMs: number;
  blockedP50: number;
  blockedP95: number;
  blockedMax: number;
  blockedTotalMs: number;
}

interface IpcChannelStats {
  channel: string;
  callCount: number;
  errorCount: number;
  slowCount: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastMs: number;
  inFlight: number;
  maxInFlight: number;
}

interface SystemStats {
  fileWatchers: {
    type: string;
    activeWorkspaces: number;
    workspaces: WorkspaceWatcherInfo[];
    totalSubscribers: number;
  };
  process: {
    memoryRssMB: number;
    heapUsedMB: number;
    heapTotalMB: number;
    activeHandles: number;
    platform: string;
    nodeVersion: string;
    electronVersion: string;
  };
  ipc: {
    registeredHandlers: number;
    channelStats: IpcChannelStats[];
  };
  database: {
    queryStats: Record<string, { reads: SampleSummary; writes: SampleSummary }>;
  };
  windows: Array<{
    id: number;
    mode: string;
    workspacePath: string | null;
    filePath: string | null;
    documentEdited: boolean;
  }>;
}

interface TimeSeriesPoint {
  time: string;
  timestamp: number;
  memoryRssMB: number;
  heapUsedMB: number;
  rendererHeapMB: number;
  activeHandles: number;
  ipcHandlers: number;
  activeWorkspaces: number;
  totalSubscribers: number;
  atomFamilies: number;
  atomInstances: number;
  dbReads: number;
  dbWrites: number;
}

const REFRESH_INTERVAL_MS = 15_000;
const MAX_HISTORY_POINTS = 120; // 30 minutes of data at 15s intervals

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchAtomFamilyStats(): Promise<AtomFamilyStat[]> {
  try {
    return await window.electronAPI.invoke('dev:get-atomfamily-stats');
  } catch {
    return [];
  }
}

async function fetchSystemStats(): Promise<SystemStats | null> {
  try {
    return await window.electronAPI.invoke('dev:get-system-stats');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chart theme
// ---------------------------------------------------------------------------

const CHART_COLORS = {
  rss: '#60a5fa',         // blue-400
  heap: '#34d399',        // emerald-400
  rendererHeap: '#818cf8', // indigo-400
  handles: '#f97316',     // orange-500
  ipcHandlers: '#e879f9', // fuchsia-400
  workspaces: '#a78bfa',  // violet-400
  subscribers: '#f472b6', // pink-400
  families: '#38bdf8',    // sky-400
  instances: '#fbbf24',   // amber-400
  dbReads: '#2dd4bf',     // teal-400
  dbWrites: '#fb923c',    // orange-400
};

// ---------------------------------------------------------------------------
// Overview Panel
// ---------------------------------------------------------------------------

function OverviewPanel({
  systemStats,
  atomStats,
  history,
}: {
  systemStats: SystemStats | null;
  atomStats: AtomFamilyStat[];
  history: TimeSeriesPoint[];
}) {
  if (!systemStats) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--nim-text-muted)]">
        Loading...
      </div>
    );
  }

  const { fileWatchers, process: proc, ipc, database: db } = systemStats;
  const totalInstances = atomStats.reduce((sum, s) => sum + s.count, 0);
  const nonEmptyFamilies = atomStats.filter(s => s.count > 0).length;

  // Renderer heap (available in Chromium)
  const perfMemory = (performance as any).memory;
  const rendererHeapMB = perfMemory ? Math.round(perfMemory.usedJSHeapSize / 1024 / 1024) : null;
  const rendererHeapTotalMB = perfMemory ? Math.round(perfMemory.jsHeapSizeLimit / 1024 / 1024) : null;

  // Database totals
  const dbStats = summarizeDatabaseQueryStats(db.queryStats);
  const totalDbReads = dbStats.totalReads;
  const totalDbWrites = dbStats.totalWrites;
  const totalIpcCalls = ipc.channelStats.reduce((sum, stat) => sum + stat.callCount, 0);
  const totalSlowIpcCalls = ipc.channelStats.reduce((sum, stat) => sum + stat.slowCount, 0);
  const hottestIpc = ipc.channelStats[0];

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto h-full">
      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Main Memory (RSS)" value={`${proc.memoryRssMB} MB`} />
        <StatCard label="Main Heap" value={`${proc.heapUsedMB} / ${proc.heapTotalMB} MB`} />
        <StatCard label="Renderer Heap" value={rendererHeapMB != null ? `${rendererHeapMB} / ${rendererHeapTotalMB} MB` : 'N/A'} />
        <StatCard label="Active Handles" value={String(proc.activeHandles)} />
        <StatCard label="IPC Handlers" value={String(ipc.registeredHandlers)} />
        <StatCard label="IPC Calls" value={String(totalIpcCalls)} />
        <StatCard label="Slow IPC Calls" value={String(totalSlowIpcCalls)} />
        <StatCard label="Watcher Type" value={fileWatchers.type.replace('WorkspaceEventBus ', '').replace(/[()]/g, '')} />
        <StatCard label="Watched Workspaces" value={String(fileWatchers.activeWorkspaces)} />
        <StatCard label="Watcher Subscribers" value={String(fileWatchers.totalSubscribers)} />
        <StatCard label="Atom Families" value={`${nonEmptyFamilies} active / ${atomStats.length} total`} />
        <StatCard label="Atom Instances" value={String(totalInstances)} />
        <StatCard label="DB Queries (5m)" value={`${totalDbReads} R / ${totalDbWrites} W`} />
        <StatCard label="DB Tables Active" value={String(dbStats.tableCount)} />
        <StatCard label="Top IPC Channel" value={hottestIpc ? hottestIpc.channel : 'N/A'} />
        <StatCard label="Top IPC p95" value={hottestIpc ? `${hottestIpc.p95Ms}ms` : 'N/A'} />
      </div>

      {/* Charts */}
      {history.length > 1 && (
        <>
          <ChartSection title="Memory">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--nim-border)" />
                <XAxis dataKey="time" stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} />
                <YAxis stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} unit=" MB" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--nim-surface)',
                    border: '1px solid var(--nim-border)',
                    borderRadius: 6,
                    color: 'var(--nim-text)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="memoryRssMB" name="Main RSS" stroke={CHART_COLORS.rss} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="heapUsedMB" name="Main Heap" stroke={CHART_COLORS.heap} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="rendererHeapMB" name="Renderer Heap" stroke={CHART_COLORS.rendererHeap} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>

          <ChartSection title="Handles and Watchers">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--nim-border)" />
                <XAxis dataKey="time" stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} />
                <YAxis stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--nim-surface)',
                    border: '1px solid var(--nim-border)',
                    borderRadius: 6,
                    color: 'var(--nim-text)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="activeHandles" name="Active Handles" stroke={CHART_COLORS.handles} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="ipcHandlers" name="IPC Handlers" stroke={CHART_COLORS.ipcHandlers} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="activeWorkspaces" name="Workspaces" stroke={CHART_COLORS.workspaces} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="totalSubscribers" name="Subscribers" stroke={CHART_COLORS.subscribers} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>

          <ChartSection title="Jotai Atom Families">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--nim-border)" />
                <XAxis dataKey="time" stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} />
                <YAxis stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--nim-surface)',
                    border: '1px solid var(--nim-border)',
                    borderRadius: 6,
                    color: 'var(--nim-text)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="atomFamilies" name="Active Families" stroke={CHART_COLORS.families} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="atomInstances" name="Live Instances" stroke={CHART_COLORS.instances} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>

          <ChartSection title="Database Queries (rolling count per sample)">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--nim-border)" />
                <XAxis dataKey="time" stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} />
                <YAxis stroke="var(--nim-text-muted)" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--nim-surface)',
                    border: '1px solid var(--nim-border)',
                    borderRadius: 6,
                    color: 'var(--nim-text)',
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="dbReads" name="Reads (5m)" stroke={CHART_COLORS.dbReads} dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="dbWrites" name="Writes (5m)" stroke={CHART_COLORS.dbWrites} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>
        </>
      )}

      {/* Database query performance table */}
      {dbStats.legacyRows.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--nim-text)] mb-2">Database Query Performance (5m window)</h3>
          <div className="overflow-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-left text-[var(--nim-text-muted)] border-b border-[var(--nim-border)]">
                  <th className="px-2 py-1.5">Table</th>
                  <th className="px-2 py-1.5 text-right">Op</th>
                  <th className="px-2 py-1.5 text-right">Count</th>
                  <th className="px-2 py-1.5 text-right">p50</th>
                  <th className="px-2 py-1.5 text-right">p95</th>
                  <th className="px-2 py-1.5 text-right">p99</th>
                  <th className="px-2 py-1.5 text-right">Max</th>
                  <th className="px-2 py-1.5 text-right">Blocked p95</th>
                </tr>
              </thead>
              <tbody>
                {dbStats.legacyRows.sort((a, b) => a.table.localeCompare(b.table)).flatMap(({ table, reads, writes }) => {
                  const rows: React.ReactElement[] = [];
                  if (reads.count > 0) {
                    rows.push(
                      <tr key={`${table}-r`} className="border-b border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]">
                        <td className="px-2 py-1 text-[var(--nim-text)]">{table}</td>
                        <td className="px-2 py-1 text-right text-[var(--nim-text-muted)]">R</td>
                        <td className="px-2 py-1 text-right">{reads.count}</td>
                        <td className="px-2 py-1 text-right">{reads.p50}ms</td>
                        <td className="px-2 py-1 text-right">{reads.p95}ms</td>
                        <td className="px-2 py-1 text-right">{reads.p99}ms</td>
                        <td className="px-2 py-1 text-right">
                          <span className={reads.max > 100 ? 'text-[var(--nim-error)]' : ''}>{reads.max}ms</span>
                        </td>
                        <td className="px-2 py-1 text-right">
                          {reads.blockedP95 > 0 ? <span className="text-[var(--nim-warning)]">{reads.blockedP95}ms</span> : '-'}
                        </td>
                      </tr>
                    );
                  }
                  if (writes.count > 0) {
                    rows.push(
                      <tr key={`${table}-w`} className="border-b border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]">
                        <td className="px-2 py-1 text-[var(--nim-text)]">{table}</td>
                        <td className="px-2 py-1 text-right text-[var(--nim-text-muted)]">W</td>
                        <td className="px-2 py-1 text-right">{writes.count}</td>
                        <td className="px-2 py-1 text-right">{writes.p50}ms</td>
                        <td className="px-2 py-1 text-right">{writes.p95}ms</td>
                        <td className="px-2 py-1 text-right">{writes.p99}ms</td>
                        <td className="px-2 py-1 text-right">
                          <span className={writes.max > 100 ? 'text-[var(--nim-error)]' : ''}>{writes.max}ms</span>
                        </td>
                        <td className="px-2 py-1 text-right">
                          {writes.blockedP95 > 0 ? <span className="text-[var(--nim-warning)]">{writes.blockedP95}ms</span> : '-'}
                        </td>
                      </tr>
                    );
                  }
                  return rows;
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dbStats.sqliteRows.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--nim-text)] mb-2">Database Query Activity (5m window)</h3>
          <div className="overflow-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-left text-[var(--nim-text-muted)] border-b border-[var(--nim-border)]">
                  <th className="px-2 py-1.5">Table</th>
                  <th className="px-2 py-1.5 text-right">Reads</th>
                  <th className="px-2 py-1.5 text-right">Writes</th>
                  <th className="px-2 py-1.5 text-right">Total ms</th>
                  <th className="px-2 py-1.5 text-right">p99</th>
                </tr>
              </thead>
              <tbody>
                {dbStats.sqliteRows
                  .sort((a, b) => a.table.localeCompare(b.table))
                  .map((row) => (
                    <tr key={row.table} className="border-b border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]">
                      <td className="px-2 py-1 text-[var(--nim-text)]">{row.table}</td>
                      <td className="px-2 py-1 text-right">{row.reads}</td>
                      <td className="px-2 py-1 text-right">{row.writes}</td>
                      <td className="px-2 py-1 text-right">{row.totalMs}ms</td>
                      <td className="px-2 py-1 text-right">{row.p99}ms</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {ipc.channelStats.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--nim-text)] mb-2">IPC Channels</h3>
          <div className="overflow-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-left text-[var(--nim-text-muted)] border-b border-[var(--nim-border)]">
                  <th className="px-2 py-1.5">Channel</th>
                  <th className="px-2 py-1.5 text-right">Calls</th>
                  <th className="px-2 py-1.5 text-right">Errors</th>
                  <th className="px-2 py-1.5 text-right">Slow</th>
                  <th className="px-2 py-1.5 text-right">Avg</th>
                  <th className="px-2 py-1.5 text-right">p95</th>
                  <th className="px-2 py-1.5 text-right">Max</th>
                  <th className="px-2 py-1.5 text-right">Inflight</th>
                </tr>
              </thead>
              <tbody>
                {ipc.channelStats.map((stat) => (
                  <tr key={stat.channel} className="border-b border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]">
                    <td className="px-2 py-1 text-[var(--nim-text)]">{stat.channel}</td>
                    <td className="px-2 py-1 text-right">{stat.callCount}</td>
                    <td className="px-2 py-1 text-right">
                      {stat.errorCount > 0 ? <span className="text-[var(--nim-error)]">{stat.errorCount}</span> : 0}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {stat.slowCount > 0 ? <span className="text-[var(--nim-warning)]">{stat.slowCount}</span> : 0}
                    </td>
                    <td className="px-2 py-1 text-right">{stat.avgMs}ms</td>
                    <td className="px-2 py-1 text-right">{stat.p95Ms}ms</td>
                    <td className="px-2 py-1 text-right">
                      <span className={stat.maxMs > 100 ? 'text-[var(--nim-error)]' : ''}>{stat.maxMs}ms</span>
                    </td>
                    <td className="px-2 py-1 text-right">
                      {stat.inFlight}
                      {stat.maxInFlight > stat.inFlight ? ` / ${stat.maxInFlight}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* File watcher detail */}
      {fileWatchers.workspaces.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--nim-text)] mb-2">Watched Workspaces</h3>
          <div className="space-y-1">
            {fileWatchers.workspaces.map(ws => (
              <div
                key={ws.workspacePath}
                className="text-xs font-mono px-3 py-2 rounded bg-[var(--nim-surface-hover)]"
              >
                <div className="text-[var(--nim-text)]">{ws.workspacePath}</div>
                <div className="text-[var(--nim-text-muted)] mt-0.5">
                  Subscribers ({ws.subscriberCount}): {ws.subscriberIds.join(', ')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Window state detail */}
      {systemStats.windows.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--nim-text)] mb-2">Windows</h3>
          <div className="space-y-1">
            {systemStats.windows.map(win => (
              <div
                key={win.id}
                className="text-xs font-mono px-3 py-2 rounded bg-[var(--nim-surface-hover)] flex items-center gap-3"
              >
                <span className="text-[var(--nim-text-muted)]">#{win.id}</span>
                <span className="text-[var(--nim-text)]">{win.mode}</span>
                <span className="text-[var(--nim-text-muted)] truncate flex-1">
                  {win.workspacePath || win.filePath || '(none)'}
                </span>
                {win.documentEdited && (
                  <span className="text-[var(--nim-warning)] text-[10px]">edited</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* System info */}
      <div className="text-xs text-[var(--nim-text-muted)] pb-2">
        {proc.platform} | Node {proc.nodeVersion} | Electron {proc.electronVersion}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded bg-[var(--nim-surface-hover)] border border-[var(--nim-border)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--nim-text-muted)] mb-0.5">{label}</div>
      <div className="text-sm font-mono text-[var(--nim-text)]">{value}</div>
    </div>
  );
}

function ChartSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-[var(--nim-text)] mb-2">{title}</h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AtomFamily Panel (preserved from original)
// ---------------------------------------------------------------------------

function AtomFamilyPanel({ stats, loading, refresh }: { stats: AtomFamilyStat[]; loading: boolean; refresh: () => void }) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [filterEmpty, setFilterEmpty] = useState(true);

  const displayed = filterEmpty ? stats.filter(s => s.count > 0) : stats;
  const totalInstances = stats.reduce((sum, s) => sum + s.count, 0);
  const nonEmptyCount = stats.filter(s => s.count > 0).length;

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-[var(--nim-border)] text-sm">
        <span className="text-[var(--nim-text-muted)]">
          {stats.length} families registered
        </span>
        <span className="text-[var(--nim-text-muted)]">|</span>
        <span className="text-[var(--nim-text)]">
          <strong>{totalInstances}</strong> live instances across <strong>{nonEmptyCount}</strong> families
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 cursor-pointer text-[var(--nim-text-muted)]">
          <input
            type="checkbox"
            checked={filterEmpty}
            onChange={e => setFilterEmpty(e.target.checked)}
            className="accent-[var(--nim-accent)]"
          />
          Hide empty
        </label>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-3 py-1 rounded text-xs bg-[var(--nim-surface-hover)] text-[var(--nim-text)] hover:bg-[var(--nim-surface-active)] transition-colors disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-[var(--nim-surface)] z-10">
            <tr className="text-left text-[var(--nim-text-muted)] border-b border-[var(--nim-border)]">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium w-20">File</th>
              <th className="px-4 py-2 font-medium w-24 text-right">Instances</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map(s => {
              const key = `${s.name}-${s.file}`;
              const isExpanded = expandedRow === key;
              return (
                <React.Fragment key={key}>
                  <tr
                    className="border-b border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)] cursor-pointer transition-colors"
                    onClick={() => setExpandedRow(isExpanded ? null : key)}
                  >
                    <td className="px-4 py-2 font-mono text-[var(--nim-text)]">
                      <span className="mr-1.5 text-[var(--nim-text-muted)] text-xs">
                        {isExpanded ? '\u25BC' : '\u25B6'}
                      </span>
                      {s.name}
                    </td>
                    <td className="px-4 py-2 text-[var(--nim-text-muted)]">{s.file}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      <CountBadge count={s.count} />
                    </td>
                  </tr>
                  {isExpanded && s.params.length > 0 && (
                    <tr className="bg-[var(--nim-surface)]">
                      <td colSpan={3} className="px-8 py-2">
                        <div className="text-xs text-[var(--nim-text-muted)] mb-1">
                          Live params ({s.params.length}):
                        </div>
                        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
                          {s.params.map((p, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 rounded text-xs font-mono bg-[var(--nim-surface-hover)] text-[var(--nim-text)]"
                              title={p}
                            >
                              {p.length > 40 ? p.slice(0, 37) + '...' : p}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {displayed.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-[var(--nim-text-muted)]">
                  {filterEmpty ? 'No families with live instances' : 'No families registered'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  const color = count === 0
    ? 'text-[var(--nim-text-muted)]'
    : count > 50
      ? 'text-[var(--nim-error)] font-bold'
      : 'text-[var(--nim-text)]';
  return <span className={color}>{count}</span>;
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'atomfamily', label: 'Atom Families' },
];

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function DeveloperDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [atomStats, setAtomStats] = useState<AtomFamilyStat[]>([]);
  const [history, setHistory] = useState<TimeSeriesPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [sys, atoms] = await Promise.all([fetchSystemStats(), fetchAtomFamilyStats()]);
      const now = new Date();
      setSystemStats(sys);
      setAtomStats(atoms);
      setLastRefresh(now);

      if (sys) {
        const nonEmptyFamilies = atoms.filter(s => s.count > 0).length;
        const totalInstances = atoms.reduce((sum, s) => sum + s.count, 0);
        const perfMem = (performance as any).memory;
        const dbStats = summarizeDatabaseQueryStats(sys.database.queryStats);
        const dbReadCount = dbStats.totalReads;
        const dbWriteCount = dbStats.totalWrites;

        const point: TimeSeriesPoint = {
          time: formatTime(now),
          timestamp: now.getTime(),
          memoryRssMB: sys.process.memoryRssMB,
          heapUsedMB: sys.process.heapUsedMB,
          rendererHeapMB: perfMem ? Math.round(perfMem.usedJSHeapSize / 1024 / 1024) : 0,
          activeHandles: sys.process.activeHandles,
          ipcHandlers: sys.ipc.registeredHandlers,
          activeWorkspaces: sys.fileWatchers.activeWorkspaces,
          totalSubscribers: sys.fileWatchers.totalSubscribers,
          atomFamilies: nonEmptyFamilies,
          atomInstances: totalInstances,
          dbReads: dbReadCount,
          dbWrites: dbWriteCount,
        };

        setHistory(prev => {
          const next = [...prev, point];
          return next.length > MAX_HISTORY_POINTS ? next.slice(-MAX_HISTORY_POINTS) : next;
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh every 15 seconds
  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  return (
    <div className="flex flex-col h-screen bg-[var(--nim-surface)] text-[var(--nim-text)] select-text">
      {/* Title bar drag region (macOS) */}
      <div className="h-8 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 border-b border-[var(--nim-border)]">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2 text-sm transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-[var(--nim-accent)] text-[var(--nim-text)]'
                : 'border-transparent text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-xs text-[var(--nim-text-muted)]">
          {loading && <span className="animate-pulse">Refreshing...</span>}
          {lastRefresh && !loading && (
            <span>Last: {formatTime(lastRefresh)}</span>
          )}
          <span className="opacity-50">Auto-refresh 15s</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'overview' && (
          <OverviewPanel systemStats={systemStats} atomStats={atomStats} history={history} />
        )}
        {activeTab === 'atomfamily' && (
          <AtomFamilyPanel stats={atomStats} loading={loading} refresh={refresh} />
        )}
      </div>
    </div>
  );
}
