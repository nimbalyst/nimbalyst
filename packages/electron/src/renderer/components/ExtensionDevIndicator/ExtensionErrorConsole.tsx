import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';
type LogSource = 'renderer' | 'main' | 'build';

interface ExtensionLogEntry {
  timestamp: number;
  level: LogLevel;
  source: LogSource;
  extensionId?: string;
  message: string;
  stack?: string;
  line?: number;
  sourceFile?: string;
}

interface ExtensionErrorConsoleProps {
  isOpen: boolean;
  onClose: () => void;
}

const LOG_LEVEL_ICONS: Record<LogLevel, string> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
  debug: 'bug_report',
};

interface InstalledExtension {
  id: string;
  name: string;
  enabled: boolean;
}

export const ExtensionErrorConsole: React.FC<ExtensionErrorConsoleProps> = ({
  isOpen,
  onClose,
}) => {
  const [logs, setLogs] = useState<ExtensionLogEntry[]>([]);
  const [installedExtensions, setInstalledExtensions] = useState<InstalledExtension[]>([]);
  const [stats, setStats] = useState<{
    totalEntries: number;
    byLevel: Record<LogLevel, number>;
  } | null>(null);
  const [filter, setFilter] = useState<{
    logLevel: LogLevel | 'all';
    source: LogSource | 'all';
    extensionId: string;
  }>({
    logLevel: 'all',
    source: 'all',
    extensionId: '',
  });
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Fetch installed extensions on open
  useEffect(() => {
    if (!isOpen) return;

    const fetchExtensions = async () => {
      try {
        const extensions = await window.electronAPI.extensions.listInstalled();
        setInstalledExtensions(extensions || []);
      } catch (error) {
        console.error('[ExtensionErrorConsole] Failed to fetch extensions:', error);
      }
    };

    fetchExtensions();
  }, [isOpen]);

  const fetchLogs = useCallback(async () => {
    if (!isOpen) return;

    setIsLoading(true);
    try {
      const result = await window.electronAPI.extensionDevTools.getLogs({
        logLevel: filter.logLevel,
        source: filter.source,
        extensionId: filter.extensionId || undefined,
        lastSeconds: 300, // 5 minutes
      });
      setLogs(result.logs);
      setStats(result.stats);
    } catch (error) {
      console.error('[ExtensionErrorConsole] Failed to fetch logs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [isOpen, filter]);

  // Fetch logs on open and when filter changes
  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [isOpen, fetchLogs]);

  // Auto-refresh every 2 seconds
  useEffect(() => {
    if (!isOpen || !autoRefresh) return;

    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [isOpen, autoRefresh, fetchLogs]);

  const handleClearLogs = async () => {
    try {
      await window.electronAPI.extensionDevTools.clearLogs(
        filter.extensionId || undefined
      );
      await fetchLogs();
    } catch (error) {
      console.error('[ExtensionErrorConsole] Failed to clear logs:', error);
    }
  };

  const toggleExpand = (index: number) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // Combine installed extensions with any extension IDs found in logs
  // This ensures we show both installed extensions AND any dev extensions that have logs
  const allExtensionOptions = useMemo(() => {
    const extensionMap = new Map<string, { id: string; name: string }>();

    // Add installed extensions
    for (const ext of installedExtensions) {
      if (ext.id) {
        extensionMap.set(ext.id, { id: ext.id, name: ext.name || ext.id });
      }
    }

    // Add any extension IDs from logs that aren't already in the map
    for (const log of logs) {
      if (log.extensionId && !extensionMap.has(log.extensionId)) {
        extensionMap.set(log.extensionId, { id: log.extensionId, name: log.extensionId });
      }
    }

    return Array.from(extensionMap.values()).sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id)
    );
  }, [installedExtensions, logs]);

  if (!isOpen) return null;

  return (
    <div
      className="extension-error-console-overlay nim-overlay z-[1000]"
      onClick={onClose}
    >
      <div
        className="extension-error-console flex flex-col w-4/5 max-w-[1000px] h-[70%] max-h-[600px] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.25)] nim-animate-slide-up bg-nim border border-nim"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="extension-error-console-header flex items-center gap-4 px-5 py-4 rounded-t-xl border-b border-nim bg-nim-secondary"
        >
          <h2 className="m-0 text-base font-semibold text-nim">
            Extension Logs
          </h2>
          <div className="extension-error-console-stats flex gap-3 ml-auto">
            {stats && (
              <>
                <span className="stat stat-error flex items-center gap-1 text-xs font-medium text-nim-error">
                  <MaterialSymbol icon="error" size={14} />
                  {stats.byLevel.error}
                </span>
                <span className="stat stat-warn flex items-center gap-1 text-xs font-medium text-nim-warning">
                  <MaterialSymbol icon="warning" size={14} />
                  {stats.byLevel.warn}
                </span>
                <span className="stat stat-info flex items-center gap-1 text-xs font-medium text-nim-info">
                  <MaterialSymbol icon="info" size={14} />
                  {stats.byLevel.info}
                </span>
              </>
            )}
          </div>
          <button
            className="extension-error-console-close flex items-center justify-center w-8 h-8 border-none bg-transparent rounded-md cursor-pointer transition-all duration-100 hover:bg-nim-hover hover:text-nim text-nim-muted"
            onClick={onClose}
            aria-label="Close"
          >
            <MaterialSymbol icon="close" size={20} />
          </button>
        </div>

        <div
          className="extension-error-console-toolbar flex items-center justify-between px-4 py-2 border-b border-nim bg-nim-secondary"
        >
          <div className="extension-error-console-filters flex gap-2">
            <select
              className="px-2 py-1.5 text-xs rounded-md cursor-pointer border border-nim bg-nim text-nim hover:border-[var(--nim-border-hover)]"
              value={filter.logLevel}
              onChange={(e) =>
                setFilter((f) => ({
                  ...f,
                  logLevel: e.target.value as LogLevel | 'all',
                }))
              }
              aria-label="Filter by level"
            >
              <option value="all">All Levels</option>
              <option value="error">Errors</option>
              <option value="warn">Warnings</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>

            <select
              className="px-2 py-1.5 text-xs rounded-md cursor-pointer border border-nim bg-nim text-nim hover:border-[var(--nim-border-hover)]"
              value={filter.source}
              onChange={(e) =>
                setFilter((f) => ({
                  ...f,
                  source: e.target.value as LogSource | 'all',
                }))
              }
              aria-label="Filter by source"
            >
              <option value="all">All Sources</option>
              <option value="renderer">Renderer</option>
              <option value="main">Main</option>
              <option value="build">Build</option>
            </select>

            <select
              className="px-2 py-1.5 text-xs rounded-md cursor-pointer border border-nim bg-nim text-nim hover:border-[var(--nim-border-hover)]"
              value={filter.extensionId}
              onChange={(e) =>
                setFilter((f) => ({ ...f, extensionId: e.target.value }))
              }
              aria-label="Filter by extension"
            >
              <option value="">All Extensions</option>
              {allExtensionOptions.map((ext) => (
                <option key={ext.id} value={ext.id}>
                  {ext.name}
                </option>
              ))}
            </select>
          </div>

          <div className="extension-error-console-actions flex items-center gap-2">
            <label className="auto-refresh-toggle flex items-center gap-1.5 text-xs cursor-pointer text-nim-muted">
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh
            </label>
            <button
              className="toolbar-button nim-btn-icon"
              onClick={fetchLogs}
              disabled={isLoading}
              title="Refresh"
            >
              <MaterialSymbol icon="refresh" size={18} />
            </button>
            <button
              className="toolbar-button nim-btn-icon"
              onClick={handleClearLogs}
              title="Clear logs"
            >
              <MaterialSymbol icon="delete" size={18} />
            </button>
          </div>
        </div>

        <div
          className="extension-error-console-logs flex-1 overflow-y-auto p-2 font-mono text-xs"
        >
          {logs.length === 0 ? (
            <div className="extension-error-console-empty flex flex-col items-center justify-center h-full text-center text-nim-faint">
              <MaterialSymbol icon="check_circle" size={48} />
              <p className="mt-2 mb-0">No logs to display</p>
              <p className="hint text-xs max-w-[300px]">
                Extension logs will appear here when extensions emit console
                messages or errors.
              </p>
            </div>
          ) : (
            logs.map((log, index) => (
              <div
                key={`${log.timestamp}-${index}`}
                className={`log-entry log-${log.level} px-2 py-1.5 rounded mb-0.5 transition-colors duration-100 hover:bg-[var(--nim-bg-hover)] ${
                  expandedLogs.has(index) ? 'expanded bg-[var(--nim-bg-secondary)]' : ''
                } ${log.stack ? 'cursor-pointer' : 'cursor-default'}`}
                onClick={() => log.stack && toggleExpand(index)}
              >
                <div className="log-entry-header flex items-start gap-2">
                  <span
                    className={
                      log.level === 'error'
                        ? 'text-nim-error'
                        : log.level === 'warn'
                          ? 'text-nim-warning'
                          : log.level === 'info'
                            ? 'text-nim-info'
                            : 'text-nim-faint'
                    }
                  >
                    <MaterialSymbol
                      icon={LOG_LEVEL_ICONS[log.level]}
                      size={16}
                    />
                  </span>
                  <span className="log-time shrink-0 text-nim-faint">
                    {formatTime(log.timestamp)}
                  </span>
                  <span className="log-source shrink-0 text-nim-faint">
                    [{log.source}]
                  </span>
                  {log.extensionId && (
                    <button
                      className="log-extension shrink-0 px-1 border-none rounded font-inherit cursor-pointer transition-all duration-100 text-[#a855f7] bg-[rgba(168,85,247,0.1)] hover:bg-[rgba(168,85,247,0.25)] hover:text-[#c084fc]"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFilter((f) => ({ ...f, extensionId: log.extensionId! }));
                      }}
                      title={`Filter by ${log.extensionId}`}
                    >
                      {log.extensionId}
                    </button>
                  )}
                  <span
                    className={`log-message flex-1 break-words ${
                      log.level === 'error'
                        ? 'text-nim-error'
                        : log.level === 'warn'
                          ? 'text-nim-warning'
                          : 'text-nim'
                    }`}
                  >
                    {log.message}
                  </span>
                  {log.stack && (
                    <MaterialSymbol
                      icon={expandedLogs.has(index) ? 'expand_less' : 'expand_more'}
                      size={16}
                      className="log-expand-icon shrink-0 text-nim-faint"
                    />
                  )}
                </div>
                {expandedLogs.has(index) && log.stack && (
                  <pre className="log-stack mt-2 ml-6 p-2 rounded overflow-x-auto text-[11px] whitespace-pre-wrap break-words bg-nim border border-nim text-nim-muted">
                    {log.stack}
                  </pre>
                )}
                {log.sourceFile && log.line && (
                  <div className="log-location mt-1 ml-6 text-[11px] text-nim-faint">
                    {log.sourceFile}:{log.line}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
