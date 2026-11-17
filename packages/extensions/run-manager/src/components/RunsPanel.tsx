/**
 * The Runs panel: one row per run target with its status, command, link and
 * uptime, and buttons to start, stop, restart and open the log.
 *
 * All state lives in the backend module. The panel polls it for a snapshot
 * and sends actions; it holds only what is on screen (the open form, a
 * pending confirmation, the panel height).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import type { RunPanelToolKey, RunPanelToolMap, RunView, RunsSnapshot, RunTarget } from '../shared/types';
import { createRunsClient } from './runsClient';
import {
  EMPTY_DRAFT,
  actionsFor,
  draftFromSuggestion,
  formatUptime,
  linkLabel,
  loadFailureNotice,
  statusLabel,
  targetFromDraft,
  type TargetDraft,
} from './runsModel';
import {
  ChevronDownIcon,
  LogsIcon,
  PinIcon,
  PlayBadgeIcon,
  PlusIcon,
  RestartIcon,
  RunsIcon,
  StartIcon,
  StopIcon,
} from './RunIcons';

const POLL_MS = 2000;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;
const HEIGHT_KEY = 'panelHeight';

function clampHeight(height: number): number {
  // Leave the editor above at least a third of the window.
  const ceiling = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.floor(window.innerHeight * 0.66)));
  return Math.max(MIN_HEIGHT, Math.min(ceiling, Math.round(height)));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RowProps {
  run: RunView;
  now: number;
  busy: boolean;
  confirmingStop: boolean;
  onAction: (key: 'start' | 'stop' | 'restart', run: RunView) => void;
  onLogs: (run: RunView) => void;
  onConfirmStop: (run: RunView) => void;
  onCancelStop: () => void;
}

function RunRow({ run, now, busy, confirmingStop, onAction, onLogs, onConfirmStop, onCancelStop }: RowProps) {
  const actions = actionsFor(run);
  const up = run.status === 'starting' || run.status === 'running';
  const uptime = up ? formatUptime(run.startedAt, now) : '';
  const linked = run.url && (run.status === 'running' || run.status === 'external');

  return (
    <>
      <div className="run-manager-row" data-run-id={run.target.id} data-run-status={run.status}>
        <div className={`run-manager-state run-manager-state-${run.status}`}>
          <span className={`run-manager-dot run-manager-dot-${run.status}`} />
          {statusLabel(run)}
        </div>
        <div className="run-manager-name" title={run.target.name}>
          {run.target.name}
        </div>
        <div className="run-manager-cmd select-text" title={run.status === 'external' ? undefined : run.target.command}>
          {run.status === 'external' ? (
            <span className="run-manager-note">started outside Nimbalyst</span>
          ) : (
            run.target.command
          )}
        </div>
        <div className="run-manager-port">
          {run.status === 'starting' && run.waitingFor ? (
            <span className="run-manager-muted">waiting for {run.waitingFor}</span>
          ) : linked ? (
            <a href={run.url} target="_blank" rel="noreferrer">
              {linkLabel(run.url!)}
            </a>
          ) : (
            <span className="run-manager-muted">{run.url ? linkLabel(run.url) : '—'}</span>
          )}
        </div>
        <div className={`run-manager-uptime${uptime ? '' : ' run-manager-uptime-none'}`}>{uptime || '—'}</div>
        <div className="run-manager-actions">
          {actions.primary === 'start' ? (
            <button
              type="button"
              className="run-manager-icon-btn run-manager-icon-btn-start"
              title="Start"
              aria-label={`Start ${run.target.name}`}
              disabled={busy || !actions.primaryEnabled}
              onClick={() => onAction('start', run)}
            >
              <StartIcon />
            </button>
          ) : (
            <button
              type="button"
              className="run-manager-icon-btn run-manager-icon-btn-stop"
              title={actions.stopNeedsConfirmation ? 'Stop (asks for confirmation)' : 'Stop'}
              aria-label={`Stop ${run.target.name}`}
              disabled={busy || !actions.primaryEnabled}
              onClick={() => (actions.stopNeedsConfirmation ? onConfirmStop(run) : onAction('stop', run))}
            >
              <StopIcon />
            </button>
          )}
          <button
            type="button"
            className="run-manager-icon-btn"
            title="Restart"
            aria-label={`Restart ${run.target.name}`}
            disabled={busy || !actions.restartEnabled}
            onClick={() => onAction('restart', run)}
          >
            <RestartIcon />
          </button>
          <button
            type="button"
            className="run-manager-icon-btn"
            title={actions.logsHint}
            aria-label={`Logs of ${run.target.name}`}
            disabled={!actions.logsEnabled}
            onClick={() => onLogs(run)}
          >
            <LogsIcon />
          </button>
        </div>
      </div>
      {confirmingStop && (
        <div className="run-manager-row-note run-manager-row-confirm" role="alertdialog" aria-label="Confirm stop">
          <span>
            Process {run.externalPid} is listening on port {run.target.port} and was not started by Nimbalyst. Stop it?
          </span>
          <button type="button" className="run-manager-btn run-manager-btn-danger" onClick={() => onAction('stop', run)}>
            Stop process
          </button>
          <button type="button" className="run-manager-btn" onClick={onCancelStop}>
            Cancel
          </button>
        </div>
      )}
      {run.error && <div className="run-manager-row-note run-manager-row-error select-text">{run.error}</div>}
    </>
  );
}

interface FormProps {
  draft: TargetDraft;
  error: string | null;
  saving: boolean;
  suggestions: RunTarget[];
  onChange: (draft: TargetDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

function AddTargetForm({ draft, error, saving, suggestions, onChange, onSave, onCancel }: FormProps) {
  const set = (field: keyof TargetDraft) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [field]: event.target.value });
  return (
    <form
      className="run-manager-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      {suggestions.length > 0 && (
        <div className="run-manager-suggestions">
          <span className="run-manager-muted-text">From package.json:</span>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="run-manager-chip"
              onClick={() => onChange(draftFromSuggestion(suggestion))}
            >
              {suggestion.command}
            </button>
          ))}
        </div>
      )}
      <div className="run-manager-form-fields">
        <label className="run-manager-field">
          <span>Name</span>
          <input autoFocus value={draft.name} onChange={set('name')} placeholder="Web dev server" />
        </label>
        <label className="run-manager-field run-manager-field-wide">
          <span>Command</span>
          <input className="run-manager-mono" value={draft.command} onChange={set('command')} placeholder="pnpm run dev" spellCheck={false} />
        </label>
        <label className="run-manager-field run-manager-field-narrow">
          <span>Port (optional)</span>
          <input className="run-manager-mono" value={draft.port} onChange={set('port')} placeholder="5173" inputMode="numeric" />
        </label>
        <label className="run-manager-field">
          <span>Folder (optional)</span>
          <input className="run-manager-mono" value={draft.cwd} onChange={set('cwd')} placeholder="packages/web" spellCheck={false} />
        </label>
        <div className="run-manager-form-buttons">
          <button type="submit" className="run-manager-btn run-manager-btn-primary" disabled={saving}>
            Add
          </button>
          <button type="button" className="run-manager-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      {error && <div className="run-manager-form-error">{error}</div>}
    </form>
  );
}

export function RunsPanel({ host }: PanelHostProps) {
  const client = useMemo(() => createRunsClient(host), [host]);
  const [snapshot, setSnapshot] = useState<RunsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TargetDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [height, setHeight] = useState(() => clampHeight(host.storage.get<number>(HEIGHT_KEY) ?? DEFAULT_HEIGHT));
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef({ y: 0, height: 0 });
  const heightRef = useRef(height);
  heightRef.current = height;
  // A slow poll must not overwrite the snapshot an action returned after it.
  const requestSeq = useRef(0);
  const mountedAt = useRef(Date.now());

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const next = await client.call('state', {});
      if (seq === requestSeq.current) {
        setSnapshot(next);
        setLoadError(null);
      }
    } catch (error) {
      if (seq === requestSeq.current) {
        // The backend module is not answering, so the rows on screen can no
        // longer be trusted: the host stops a module's runs when it stops.
        setSnapshot(null);
        setLoadError(errorText(error));
      }
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const run = useCallback(
    async <K extends Exclude<RunPanelToolKey, 'state' | 'revealLogs'>>(
      key: K,
      id: string,
      request: RunPanelToolMap[K][0]
    ) => {
      setBusy((current) => new Set(current).add(id));
      setActionError(null);
      const seq = ++requestSeq.current;
      try {
        const next = (await client.call(key, request)) as RunsSnapshot;
        if (seq === requestSeq.current) setSnapshot(next);
        else void refresh();
      } catch (error) {
        setActionError(errorText(error));
        void refresh();
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [client, refresh]
  );

  const handleAction = useCallback(
    (key: 'start' | 'stop' | 'restart', target: RunView) => {
      const id = target.target.id;
      setConfirmStopId(null);
      if (key === 'stop' && target.status === 'external') {
        if (target.externalPid) void run('stopExternal', id, { id, pid: target.externalPid });
        return;
      }
      void run(key, id, { id });
    },
    [run]
  );

  const handleLogs = useCallback(
    (target: RunView) => {
      setActionError(null);
      client.call('revealLogs', { id: target.target.id }).catch((error) => setActionError(errorText(error)));
    },
    [client]
  );

  const openForm = useCallback(() => {
    const first = snapshot?.suggestions[0];
    setDraft(first ? draftFromSuggestion(first) : EMPTY_DRAFT);
    setFormError(null);
  }, [snapshot]);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const existing = new Set((snapshot?.runs ?? []).map((item) => item.target.id));
    const result = targetFromDraft(draft, existing);
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    setSaving(true);
    const seq = ++requestSeq.current;
    try {
      const next = await client.call('saveTarget', { target: result.target });
      if (seq === requestSeq.current) setSnapshot(next);
      else void refresh();
      setDraft(null);
      setFormError(null);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setSaving(false);
    }
  }, [client, draft, refresh, snapshot]);

  const startResize = useCallback((event: React.MouseEvent) => {
    resizeStart.current = { y: event.clientY, height: heightRef.current };
    setResizing(true);
    event.preventDefault();
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: MouseEvent) => {
      setHeight(clampHeight(resizeStart.current.height + (resizeStart.current.y - event.clientY)));
    };
    const onUp = () => {
      setResizing(false);
      void host.storage.set(HEIGHT_KEY, heightRef.current);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [resizing, host]);

  const runs = snapshot?.runs ?? [];
  const logTabs = runs.filter((item) => item.hasLogs);
  const configFile = snapshot ? `${host.workspacePath}/${snapshot.configPath}` : null;
  const loadNotice = loadFailureNotice(snapshot !== null, loadError, now - mountedAt.current);

  return (
    <div className="run-manager-panel" style={{ height }} data-testid="runs-panel">
      <div
        className="run-manager-resize-handle"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the Runs panel"
      />
      <div className="run-manager-tabs">
        <div className="run-manager-tab run-manager-tab-active">
          <RunsIcon />
          Runs
        </div>
        {logTabs.length > 0 && <div className="run-manager-tab-sep" />}
        {logTabs.map((item) => (
          <button
            key={item.target.id}
            type="button"
            className="run-manager-tab"
            title={`Open the log of ${item.target.name}`}
            data-run-log-tab={item.target.id}
            onClick={() => handleLogs(item)}
          >
            <span className={`run-manager-dot run-manager-dot-${item.status}`} />
            <span className="run-manager-run-badge">
              <PlayBadgeIcon />
            </span>
            {item.target.name}
            <span className="run-manager-pin">
              <PinIcon />
            </span>
          </button>
        ))}
        <div className="run-manager-tab-actions">
          {snapshot?.configExists && configFile && (
            <button
              type="button"
              className="run-manager-link-btn"
              title="Edit the run targets file"
              onClick={() => host.openFile(configFile)}
            >
              {snapshot.configPath}
            </button>
          )}
          <button
            type="button"
            className="run-manager-icon-btn"
            title="Hide the Runs panel"
            aria-label="Hide the Runs panel"
            onClick={() => host.close()}
          >
            <ChevronDownIcon />
          </button>
        </div>
      </div>

      <div className="run-manager-view">
        {loadNotice?.kind === 'starting' && <div className="run-manager-banner run-manager-banner-muted">Starting the run manager...</div>}
        {loadNotice?.kind === 'error' && (
          <div className="run-manager-banner run-manager-banner-error select-text">Could not read the runs: {loadNotice.message}</div>
        )}
        {actionError && <div className="run-manager-banner run-manager-banner-error select-text">{actionError}</div>}
        {snapshot?.configErrors.map((problem) => (
          <div key={problem} className="run-manager-banner run-manager-banner-warning select-text">
            {snapshot.configPath}: {problem}
          </div>
        ))}

        {runs.length > 0 && (
          <div className="run-manager-row run-manager-row-header">
            <div>Status</div>
            <div>Name</div>
            <div>Command</div>
            <div>Port / URL</div>
            <div>Uptime</div>
            <div />
          </div>
        )}
        {runs.map((item) => (
          <RunRow
            key={item.target.id}
            run={item}
            now={now}
            busy={busy.has(item.target.id)}
            confirmingStop={confirmStopId === item.target.id}
            onAction={handleAction}
            onLogs={handleLogs}
            onConfirmStop={(target) => setConfirmStopId(target.target.id)}
            onCancelStop={() => setConfirmStopId(null)}
          />
        ))}

        {snapshot && runs.length === 0 && !draft && (
          <div className="run-manager-empty">
            A run target is a named command for a long-running process of this project, such as a dev server. Targets are
            saved in <code>{snapshot.configPath}</code> so the whole team shares them.
          </div>
        )}

        {draft ? (
          <AddTargetForm
            draft={draft}
            error={formError}
            saving={saving}
            suggestions={snapshot?.suggestions ?? []}
            onChange={setDraft}
            onSave={() => void saveDraft()}
            onCancel={() => setDraft(null)}
          />
        ) : (
          snapshot && (
            <button type="button" className="run-manager-add-target" onClick={openForm}>
              <PlusIcon />
              Add run target
            </button>
          )
        )}
      </div>
    </div>
  );
}
