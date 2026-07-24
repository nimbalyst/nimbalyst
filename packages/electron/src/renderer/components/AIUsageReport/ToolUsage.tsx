import React, { useEffect, useState, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface ToolUsageProps {
  workspaceId?: string;
}

interface ToolUsageReportRow {
  toolName: string;
  mcpServer: string | null;
  count: number;
  errorCount: number;
}

interface ToolUsageReport {
  topTools: ToolUsageReportRow[];
  byKind: { builtin: number; mcp: number };
  byProvider: Array<{ provider: string; count: number }>;
  overTime: Array<{ day: string; count: number }>;
  byProject: Array<{ projectPath: string; count: number }>;
}

/** Trim `mcp__server__tool` down to a readable label; leave built-ins as-is. */
function displayToolName(row: ToolUsageReportRow): string {
  if (row.mcpServer) {
    const tool = row.toolName.replace(`mcp__${row.mcpServer}__`, '');
    return `${row.mcpServer} / ${tool}`;
  }
  return row.toolName;
}

function displayProjectName(projectPath: string): string {
  if (projectPath === '(none)') return projectPath;
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
}

export const ToolUsage: React.FC<ToolUsageProps> = ({ workspaceId }) => {
  const [report, setReport] = useState<ToolUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await window.electronAPI.toolUsage.getReport(
        workspaceId,
      )) as ToolUsageReport;
      setReport(result);
    } catch (error) {
      console.error('[ToolUsage] Failed to load tool usage report:', error);
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    try {
      await window.electronAPI.toolUsage.backfill();
      await loadData();
    } catch (error) {
      console.error('[ToolUsage] Backfill failed:', error);
    } finally {
      setBackfilling(false);
    }
  }, [loadData]);

  const total = report ? report.byKind.builtin + report.byKind.mcp : 0;
  const maxCount = report?.topTools[0]?.count || 1;

  return (
    <div className="tool-usage-report flex flex-col gap-4">
      <div className="tool-usage-header flex items-center justify-between">
        <h3 className="m-0 text-sm font-semibold text-[var(--nim-text)]">
          Tool Usage
        </h3>
        <button
          type="button"
          onClick={handleBackfill}
          disabled={backfilling}
          className={`tool-usage-backfill text-[11px] px-2 py-1 rounded-sm border border-nim ${
            backfilling
              ? 'opacity-50 cursor-default'
              : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]'
          }`}
          title="Populate historical tool usage from past claude-code and codex sessions"
        >
          {backfilling ? 'Backfilling...' : 'Backfill history'}
        </button>
      </div>

      {loading ? (
        <div className="tool-usage-loading text-xs text-[var(--nim-text-muted)]">
          Loading...
        </div>
      ) : !report || total === 0 ? (
        <div className="tool-usage-empty text-xs text-[var(--nim-text-muted)]">
          No tool usage recorded yet. Run an agent session, or use "Backfill
          history" to import past sessions.
        </div>
      ) : (
        <>
          <div className="tool-usage-kind flex gap-4">
            <div className="tool-usage-kind-stat flex-1 bg-[var(--nim-bg-tertiary)] rounded-md p-3">
              <div className="text-[11px] text-[var(--nim-text-muted)]">
                Built-in tools
              </div>
              <div className="text-lg font-semibold text-[var(--nim-text)]">
                {report.byKind.builtin.toLocaleString()}
              </div>
            </div>
            <div className="tool-usage-kind-stat flex-1 bg-[var(--nim-bg-tertiary)] rounded-md p-3">
              <div className="text-[11px] text-[var(--nim-text-muted)]">
                MCP / extension tools
              </div>
              <div className="text-lg font-semibold text-[var(--nim-text)]">
                {report.byKind.mcp.toLocaleString()}
              </div>
            </div>
          </div>

          <div className="tool-usage-top">
            <h4 className="m-0 mb-2 text-xs font-semibold text-[var(--nim-text-muted)]">
              Most-used tools
            </h4>
            <div className="tool-usage-bars flex flex-col gap-2">
              {report.topTools.slice(0, 20).map((tool, index) => (
                <div
                  key={index}
                  className="tool-usage-bar-item flex flex-col gap-1"
                >
                  <div className="tool-usage-bar-label flex justify-between items-center">
                    <span className="tool-usage-bar-name text-xs font-medium text-[var(--nim-text)] truncate">
                      {displayToolName(tool)}
                    </span>
                    <span className="tool-usage-bar-count text-[11px] text-[var(--nim-text-muted)] shrink-0 ml-2">
                      {tool.count.toLocaleString()}
                      {tool.errorCount > 0 ? ` (${tool.errorCount} err)` : ''}
                    </span>
                  </div>
                  <div className="tool-usage-bar-track h-1.5 bg-[var(--nim-bg-tertiary)] rounded-sm overflow-hidden">
                    <div
                      className={`tool-usage-bar-fill h-full rounded-sm transition-[width] duration-300 ease-out ${
                        tool.mcpServer
                          ? 'bg-[var(--nim-accent)]'
                          : 'bg-[var(--nim-primary)]'
                      }`}
                      style={{ width: `${(tool.count / maxCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {report.overTime.length > 1 && (
            <div className="tool-usage-over-time">
              <h4 className="m-0 mb-2 text-xs font-semibold text-[var(--nim-text-muted)]">
                Tool calls over time
              </h4>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={report.overTime}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--nim-border)"
                  />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: 'var(--nim-text-muted)' }}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--nim-text-muted)' }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--nim-bg-secondary)',
                      border: '1px solid var(--nim-border)',
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="var(--nim-primary)"
                    fill="var(--nim-primary)"
                    fillOpacity={0.2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {report.byProvider.length > 1 && (
            <div className="tool-usage-by-provider">
              <h4 className="m-0 mb-2 text-xs font-semibold text-[var(--nim-text-muted)]">
                By provider
              </h4>
              <div className="tool-usage-provider-bars flex flex-col gap-2">
                {report.byProvider.map((p, index) => {
                  const maxProvider = report.byProvider[0]?.count || 1;
                  return (
                    <div
                      key={index}
                      className="tool-usage-provider-item flex flex-col gap-1"
                    >
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-medium text-[var(--nim-text)]">
                          {p.provider}
                        </span>
                        <span className="text-[11px] text-[var(--nim-text-muted)]">
                          {p.count.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-1.5 bg-[var(--nim-bg-tertiary)] rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-[var(--nim-primary)] rounded-sm"
                          style={{ width: `${(p.count / maxProvider) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {report.byProject.length > 0 && (
            <div className="tool-usage-by-project">
              <h4 className="m-0 mb-2 text-xs font-semibold text-[var(--nim-text-muted)]">
                By project
              </h4>
              <div className="tool-usage-project-bars flex flex-col gap-2">
                {report.byProject.map((project) => {
                  const maxProject = report.byProject[0]?.count || 1;
                  return (
                    <div
                      key={project.projectPath}
                      className="tool-usage-project-item flex flex-col gap-1"
                    >
                      <div className="flex justify-between items-center gap-2">
                        <span
                          className="text-xs font-medium text-[var(--nim-text)] truncate"
                          title={project.projectPath}
                        >
                          {displayProjectName(project.projectPath)}
                        </span>
                        <span className="text-[11px] text-[var(--nim-text-muted)] shrink-0">
                          {project.count.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-1.5 bg-[var(--nim-bg-tertiary)] rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-[var(--nim-accent)] rounded-sm"
                          style={{
                            width: `${(project.count / maxProject) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
