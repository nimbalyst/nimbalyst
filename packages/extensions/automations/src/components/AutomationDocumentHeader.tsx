/**
 * AutomationDocumentHeader - Compact schedule controls above the editor.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AutomationStatus, AutomationSchedule, DayOfWeek, ScheduleType, ExecutionRecord } from '../frontmatter/types';

interface AIModel {
  id: string;
  name: string;
  provider: string;
}

import { ALL_DAYS, DAY_LABELS } from '../frontmatter/types';
import { parseAutomationStatus, updateAutomationStatus } from '../frontmatter/parser';
import { formatSchedule, formatRelativeTime, calculateNextRun } from '../scheduler/scheduleUtils';

/** Load execution history from history.json in the output directory. */
function useExecutionHistory(outputLocation: string | undefined) {
  const [records, setRecords] = useState<ExecutionRecord[]>([]);

  const refresh = useCallback(async () => {
    if (!outputLocation) return;
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) return;
    try {
      const state = await electronAPI.getInitialState();
      const wp = state?.workspacePath;
      if (!wp) return;
      const location = outputLocation.endsWith('/') ? outputLocation : outputLocation + '/';
      const historyPath = location + 'history.json';
      const absPath = historyPath.startsWith('/') ? historyPath : `${wp}/${historyPath}`;
      const result = await electronAPI.readFileContent(absPath);
      const raw = typeof result === 'string' ? result : result?.content;
      if (raw) {
        const parsed: ExecutionRecord[] = JSON.parse(raw);
        // Newest first
        setRecords(parsed.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
      }
    } catch {
      setRecords([]);
    }
  }, [outputLocation]);

  useEffect(() => { refresh(); }, [refresh]);

  const openFile = useCallback(async (filePath: string) => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.invoke) return;
    const state = await electronAPI.getInitialState();
    const wp = state?.workspacePath;
    if (!wp) return;
    const absPath = filePath.startsWith('/') ? filePath : `${wp}/${filePath}`;
    // Use workspace:open-file which sends open-document event to properly open/switch tabs
    electronAPI.invoke('workspace:open-file', { workspacePath: wp, filePath: absPath });
  }, []);

  return { records, openFile, refresh };
}

/** Format duration in human-readable form. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

interface DocumentHeaderComponentProps {
  filePath: string;
  fileName: string;
  getContent: () => string;
  contentVersion: number;
  onContentChange?: (newContent: string) => void;
  editor?: unknown;
}

let runNowCallback: ((filePath: string) => void) | null = null;
export function setRunNowCallback(cb: (filePath: string) => void): void {
  runNowCallback = cb;
}

let definitionChangedCallback: ((filePath: string, content: string) => void) | null = null;
export function setDefinitionChangedCallback(cb: (filePath: string, content: string) => void): void {
  definitionChangedCallback = cb;
}

export const AutomationDocumentHeader: React.FC<DocumentHeaderComponentProps> = ({
  filePath,
  getContent,
  contentVersion,
  onContentChange,
}) => {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [availableModels, setAvailableModels] = useState<AIModel[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.aiGetModels) return;
    electronAPI.aiGetModels().then((response: any) => {
      if (response?.success && response.grouped) {
        const models: AIModel[] = [];
        for (const [provider, providerModels] of Object.entries(response.grouped)) {
          for (const m of providerModels as any[]) {
            models.push({ id: m.id, name: m.name, provider });
          }
        }
        setAvailableModels(models);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const content = getContent();
    const parsed = parseAutomationStatus(content);
    setStatus(parsed);
  }, [getContent, contentVersion]);

  const handleUpdate = useCallback(
    (updates: Partial<AutomationStatus>) => {
      if (!onContentChange) return;
      const content = getContent();
      const updated = updateAutomationStatus(content, updates);
      onContentChange(updated);
      // Nudge the scheduler to (re)arm from the new definition immediately,
      // instead of waiting up to 30s for the disk poll to notice.
      definitionChangedCallback?.(filePath, updated);
    },
    [filePath, getContent, onContentChange],
  );

  const handleToggleEnabled = useCallback(() => {
    if (!status) return;
    const nextRun = !status.enabled ? calculateNextRun(status.schedule)?.toISOString() : undefined;
    handleUpdate({ enabled: !status.enabled, nextRun });
  }, [status, handleUpdate]);

  const handleScheduleTypeChange = useCallback(
    (type: ScheduleType) => {
      if (!status) return;
      let schedule: AutomationSchedule;
      const prevTime = (status.schedule as any).time ?? '09:00';
      switch (type) {
        case 'interval':
          schedule = { type: 'interval', intervalMinutes: 60 };
          break;
        case 'daily':
          schedule = { type: 'daily', time: prevTime };
          break;
        case 'weekly':
          schedule = { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: prevTime };
          break;
      }
      const nextRun = status.enabled ? calculateNextRun(schedule)?.toISOString() : undefined;
      handleUpdate({ schedule, nextRun });
    },
    [status, handleUpdate],
  );

  const handleDayToggle = useCallback(
    (day: DayOfWeek) => {
      if (!status || status.schedule.type !== 'weekly') return;
      const days = status.schedule.days.includes(day)
        ? status.schedule.days.filter((d) => d !== day)
        : [...status.schedule.days, day];
      if (days.length === 0) return;
      const schedule: AutomationSchedule = { type: 'weekly', days, time: status.schedule.time };
      const nextRun = status.enabled ? calculateNextRun(schedule)?.toISOString() : undefined;
      handleUpdate({ schedule, nextRun });
    },
    [status, handleUpdate],
  );

  const handleTimeChange = useCallback(
    (time: string) => {
      if (!status || status.schedule.type === 'interval') return;
      const schedule: AutomationSchedule = status.schedule.type === 'weekly'
        ? { type: 'weekly', days: status.schedule.days, time }
        : { type: 'daily', time };
      const nextRun = status.enabled ? calculateNextRun(schedule)?.toISOString() : undefined;
      handleUpdate({ schedule, nextRun });
    },
    [status, handleUpdate],
  );

  const handleModelChange = useCallback(
    (model: string) => {
      if (!status) return;
      const [provider] = model.split(':');
      const providerValue = (provider === 'claude-code' || provider === 'claude' || provider === 'openai')
        ? provider as 'claude-code' | 'claude' | 'openai'
        : undefined;
      handleUpdate({ model: model || undefined, provider: providerValue });
    },
    [status, handleUpdate],
  );

  const handleRunNow = useCallback(() => {
    if (runNowCallback && !isRunning) {
      setIsRunning(true);
      runNowCallback(filePath);
      // The scheduler handles execution asynchronously and shows its own
      // success/error toasts. We just show a brief "running" state on the button.
      // Reset after a reasonable timeout since we don't have a completion callback.
      setTimeout(() => setIsRunning(false), 5000);
    }
  }, [filePath, isRunning]);

  const { records: historyRecords, openFile: openHistoryFile, refresh: refreshHistory } = useExecutionHistory(status?.output?.location);
  const [showHistory, setShowHistory] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showHistory) return;
    const handler = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHistory]);

  // Refresh history when dropdown opens
  const handleToggleHistory = useCallback(() => {
    if (!showHistory) refreshHistory();
    setShowHistory((v) => !v);
  }, [showHistory, refreshHistory]);

  if (!status) return null;

  const time = status.schedule.type !== 'interval'
    ? (status.schedule as { time: string }).time
    : '';

  return (
    <div className="automation-header">
      <div className="automation-header__row">
        {/* Icon */}
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--nim-primary, #60a5fa)', fontVariationSettings: "'FILL' 1" }}>auto_mode</span>

        {/* Enable toggle */}
        <button
          className={`automation-header__toggle ${status.enabled ? 'automation-header__toggle--active' : ''}`}
          onClick={handleToggleEnabled}
          aria-label={status.enabled ? 'Disable automation' : 'Enable automation'}
        >
          <span className="automation-header__toggle-knob" />
        </button>

        {/* Schedule type */}
        <div className="automation-header__segmented">
          {(['daily', 'weekly', 'interval'] as ScheduleType[]).map((t) => (
            <button
              key={t}
              className={`automation-header__seg-btn ${status.schedule.type === t ? 'automation-header__seg-btn--active' : ''}`}
              onClick={() => handleScheduleTypeChange(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Day chips (weekly only) */}
        {status.schedule.type === 'weekly' && (
          <div className="automation-header__day-picker">
            {ALL_DAYS.map((day) => (
              <button
                key={day}
                className={`automation-header__day-chip ${status.schedule.type === 'weekly' && status.schedule.days.includes(day) ? 'automation-header__day-chip--active' : ''}`}
                onClick={() => handleDayToggle(day)}
              >
                {DAY_LABELS[day]}
              </button>
            ))}
          </div>
        )}

        {/* Time input (daily/weekly) */}
        {status.schedule.type !== 'interval' && (
          <input
            type="time"
            className="automation-header__time-input"
            value={time}
            onChange={(e) => handleTimeChange(e.target.value)}
          />
        )}

        {/* Interval input */}
        {status.schedule.type === 'interval' && (
          <div className="automation-header__interval">
            <span className="automation-header__dim">every</span>
            <input
              type="number"
              className="automation-header__interval-input"
              min={1}
              value={status.schedule.intervalMinutes}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val > 0) {
                  handleUpdate({ schedule: { type: 'interval', intervalMinutes: val } });
                }
              }}
            />
            <span className="automation-header__dim">min</span>
          </div>
        )}

        <div className="automation-header__spacer" />

        {/* Model selector */}
        <select
          className="automation-header__model-select"
          value={status.model || ''}
          onChange={(e) => handleModelChange(e.target.value)}
        >
          <option value="">Default model</option>
          {availableModels.length > 0 && (
            Object.entries(
              availableModels.reduce<Record<string, AIModel[]>>((acc, m) => {
                if (!acc[m.provider]) acc[m.provider] = [];
                acc[m.provider].push(m);
                return acc;
              }, {})
            ).map(([provider, models]) => (
              <optgroup key={provider} label={
                provider === 'claude-code' ? 'Agent' :
                provider === 'claude' ? 'Chat' :
                provider === 'openai' ? 'OpenAI' : provider
              }>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </optgroup>
            ))
          )}
        </select>

        {/* Status info */}
        {status.lastRun && (
          <span className="automation-header__status-text">
            <span className="material-symbols-outlined" style={{
              fontSize: 14,
              color: status.lastRunStatus === 'success' ? 'var(--nim-success, #4ade80)' :
                     status.lastRunStatus === 'error' ? 'var(--nim-error, #ef4444)' :
                     'var(--nim-text-faint, #808080)',
            }}>
              {status.lastRunStatus === 'success' ? 'check_circle' : status.lastRunStatus === 'error' ? 'error' : 'schedule'}
            </span>
            {formatRelativeTime(status.lastRun)}
          </span>
        )}

        {/* History dropdown */}
        {(status.runCount > 0 || historyRecords.length > 0) && (
          <div className="automation-header__outputs" ref={historyRef}>
            <button className="automation-header__outputs-btn" onClick={handleToggleHistory}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>history</span>
              {historyRecords.length > 0 ? `${historyRecords.length} runs` : `${status.runCount} runs`}
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
                {showHistory ? 'expand_less' : 'expand_more'}
              </span>
            </button>
            {showHistory && historyRecords.length > 0 && (
              <div className="automation-header__outputs-dropdown" style={{ minWidth: 300 }}>
                {historyRecords.slice(0, 20).map((r) => (
                  <button
                    key={r.id}
                    className="automation-header__output-item"
                    onClick={() => {
                      if (r.outputFile) {
                        openHistoryFile(r.outputFile);
                        setShowHistory(false);
                      }
                    }}
                    style={{ opacity: r.outputFile ? 1 : 0.7, cursor: r.outputFile ? 'pointer' : 'default' }}
                  >
                    <span className="material-symbols-outlined" style={{
                      fontSize: 14,
                      color: r.status === 'success'
                        ? 'var(--nim-success, #4ade80)'
                        : 'var(--nim-error, #ef4444)',
                    }}>
                      {r.status === 'success' ? 'check_circle' : 'error'}
                    </span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatRelativeTime(r.timestamp)}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--nim-text-disabled, #666666)', flexShrink: 0 }}>
                      {formatDuration(r.durationMs)}
                    </span>
                    {r.outputFile && (
                      <span className="material-symbols-outlined" style={{ fontSize: 12, color: 'var(--nim-text-faint, #808080)' }}>
                        open_in_new
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {showHistory && historyRecords.length === 0 && (
              <div className="automation-header__outputs-dropdown">
                <div className="automation-header__output-empty">
                  {status.runCount > 0
                    ? 'History tracking starts from next run'
                    : 'No runs yet'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Run Now */}
        <button
          className={`automation-header__run-btn ${isRunning ? 'automation-header__run-btn--running' : ''}`}
          onClick={handleRunNow}
          disabled={isRunning}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
            {isRunning ? 'hourglass_top' : 'play_arrow'}
          </span>
          {isRunning ? 'Running...' : 'Run'}
        </button>
      </div>
    </div>
  );
};
