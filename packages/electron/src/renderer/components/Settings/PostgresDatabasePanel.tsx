import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../common/AlphaBadge';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';

interface PostgresBackendSettings {
  enabled: boolean;
  connectionString: string;
  poolMax: number;
  migrationBatchSize?: number;
  lastMigration?: {
    completedAt: string;
    rowsCopied: number;
    snapshotDir?: string;
  };
}

interface PostgresStatus {
  activeBackend: 'pglite' | 'postgres';
  envConfigured: boolean;
  defaultPgliteDir: string;
  settings: PostgresBackendSettings;
}

interface MigrationResult {
  rowsCopied: number;
  sourceDir: string;
  migratedDir: string;
  snapshotDir?: string;
  messages: string[];
}

const DEFAULT_SETTINGS: PostgresBackendSettings = {
  enabled: false,
  connectionString: '',
  poolMax: 10,
  migrationBatchSize: 200,
};

export function PostgresDatabasePanel() {
  const [settings, setSettings] = React.useState<PostgresBackendSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = React.useState<PostgresStatus | null>(null);
  const [pgliteDir, setPgliteDir] = React.useState('');
  const [replaceTarget, setReplaceTarget] = React.useState(true);
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testState, setTestState] = React.useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = React.useState('');
  const [migrationState, setMigrationState] = React.useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [migrationMessage, setMigrationMessage] = React.useState('');
  const [migrationResult, setMigrationResult] = React.useState<MigrationResult | null>(null);

  const loadSettings = React.useCallback(async () => {
    const nextStatus = await window.electronAPI.invoke('postgres:get-status') as PostgresStatus;
    setStatus(nextStatus);
    setSettings(nextStatus.settings || DEFAULT_SETTINGS);
    setPgliteDir(nextStatus.defaultPgliteDir || '');
  }, []);

  React.useEffect(() => {
    loadSettings().catch((error) => {
      setMigrationMessage(error instanceof Error ? error.message : 'Failed to load PostgreSQL settings');
    });
  }, [loadSettings]);

  const updateDraft = (updates: Partial<PostgresBackendSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
    setSaveState('idle');
  };

  const saveSettings = async () => {
    setSaveState('saving');
    try {
      const saved = await window.electronAPI.invoke('postgres:set-settings', settings) as PostgresBackendSettings;
      setSettings(saved);
      setSaveState('saved');
      await loadSettings();
    } catch (error) {
      setSaveState('error');
      setMigrationMessage(error instanceof Error ? error.message : 'Failed to save PostgreSQL settings');
    }
  };

  const testConnection = async () => {
    setTestState('testing');
    setTestMessage('');
    try {
      const result = await window.electronAPI.invoke('postgres:test-connection', settings.connectionString);
      if (result?.success) {
        setTestState('success');
        setTestMessage(`Connected to ${result.info?.database || 'PostgreSQL'}`);
      } else {
        setTestState('error');
        setTestMessage(result?.error || 'Connection failed');
      }
    } catch (error) {
      setTestState('error');
      setTestMessage(error instanceof Error ? error.message : 'Connection failed');
    }
  };

  const runMigration = async () => {
    setMigrationState('running');
    setMigrationMessage('Creating a PGLite snapshot and migrating rows...');
    setMigrationResult(null);
    try {
      const response = await window.electronAPI.invoke('postgres:migrate-pglite', {
        connectionString: settings.connectionString,
        pgliteDir,
        batchSize: settings.migrationBatchSize || 200,
        truncate: replaceTarget,
      });
      if (!response?.success) {
        throw new Error(response?.error || 'Migration failed');
      }
      setMigrationState('success');
      setMigrationResult(response.result);
      setMigrationMessage(`Migrated ${response.result.rowsCopied.toLocaleString()} rows`);
      await loadSettings();
    } catch (error) {
      setMigrationState('error');
      setMigrationMessage(error instanceof Error ? error.message : 'Migration failed');
    }
  };

  const connectionReady = settings.connectionString.trim().length > 0;
  const activeBackendLabel = status?.activeBackend === 'postgres' ? 'PostgreSQL' : 'PGLite';
  const replacingActivePostgres = status?.activeBackend === 'postgres' && replaceTarget;
  const restartRequired = status && (
    (settings.enabled && status.activeBackend !== 'postgres')
    || (!settings.enabled && status.activeBackend === 'postgres' && !status.envConfigured)
    || settings.connectionString !== status.settings.connectionString
    || settings.poolMax !== status.settings.poolMax
  );

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          PostgreSQL
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Store Nimbalyst sessions, messages, trackers, and workspace metadata in a PostgreSQL database.
        </p>
      </div>

      <div className="provider-panel-section mb-6">
        <div className="flex items-center justify-between gap-4 py-3 mb-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3">
          <div>
            <div className="text-sm font-medium text-[var(--nim-text)]">Current backend</div>
            <div className="text-xs text-[var(--nim-text-muted)]">
              {activeBackendLabel}{status?.envConfigured ? ' from environment variable' : ''}
            </div>
          </div>
          <span className="text-xs px-2 py-1 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
            {activeBackendLabel}
          </span>
        </div>

        <SettingsToggle
          checked={settings.enabled}
          onChange={(checked) => updateDraft({ enabled: checked })}
          name="Use PostgreSQL backend"
          description="Applies on the next restart. Environment variables still override saved settings."
          variant="enable"
        />

        {restartRequired && (
          <div className="flex items-start gap-2 p-3 mb-4 rounded border border-[var(--nim-warning)]/30 bg-[var(--nim-warning)]/10">
            <MaterialSymbol icon="restart_alt" size={16} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
            <p className="m-0 text-[13px] text-[var(--nim-text)] leading-snug">
              Saved database backend changes take effect after Nimbalyst restarts.
            </p>
          </div>
        )}

        <div className="setting-item py-3">
          <div className="setting-text flex flex-col gap-0.5">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Connection String</span>
            <span className="setting-description text-xs text-[var(--nim-text-muted)]">
              PostgreSQL URL used by the main Nimbalyst database backend.
            </span>
          </div>
          <input
            type="password"
            value={settings.connectionString}
            onChange={(event) => updateDraft({ connectionString: event.target.value })}
            onFocus={(event) => event.currentTarget.select()}
            placeholder="postgres://user:password@localhost:5432/nimbalyst"
            className="mt-2 w-full py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono text-sm focus:border-[var(--nim-primary)]"
          />
        </div>

        <div className="grid grid-cols-2 gap-4 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-[var(--nim-text)]">Pool Size</span>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.poolMax}
              onChange={(event) => updateDraft({ poolMax: Number(event.target.value) || 10 })}
              className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-[var(--nim-text)]">Migration Batch Size</span>
            <input
              type="number"
              min={1}
              max={5000}
              value={settings.migrationBatchSize || 200}
              onChange={(event) => updateDraft({ migrationBatchSize: Number(event.target.value) || 200 })}
              className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            />
          </label>
        </div>

        <div className="flex items-center gap-2 pt-3">
          <button
            type="button"
            onClick={saveSettings}
            className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-primary)] text-white cursor-pointer text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MaterialSymbol icon="save" size={16} />
            Save
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={!connectionReady || testState === 'testing'}
            className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MaterialSymbol icon="network_check" size={16} />
            {testState === 'testing' ? 'Testing...' : 'Test Connection'}
          </button>
          {saveState === 'saved' && <span className="text-xs text-[var(--nim-success)]">Saved</span>}
          {saveState === 'error' && <span className="text-xs text-[var(--nim-error)]">Save failed</span>}
          {testMessage && (
            <span className={`text-xs ${testState === 'success' ? 'text-[var(--nim-success)]' : 'text-[var(--nim-error)]'}`}>
              {testMessage}
            </span>
          )}
        </div>
      </div>

      <div className="provider-panel-section mb-6 pt-4 border-t border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">
          Migration
        </h4>

        <div className="setting-item py-3">
          <div className="setting-text flex flex-col gap-0.5">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">PGLite Source Directory</span>
            <span className="setting-description text-xs text-[var(--nim-text-muted)]">
              Nimbalyst will copy this directory first, then migrate from the snapshot.
            </span>
          </div>
          <input
            type="text"
            value={pgliteDir}
            onChange={(event) => setPgliteDir(event.target.value)}
            className="mt-2 w-full py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono text-xs focus:border-[var(--nim-primary)]"
          />
        </div>

        <SettingsToggle
          checked={replaceTarget}
          onChange={setReplaceTarget}
          name="Replace target data"
          description="Clear PostgreSQL tables before copying PGLite rows. Leave on for first migration into a fresh database."
        />

        {replacingActivePostgres && (
          <div className="flex items-start gap-2 p-3 mt-2 rounded border border-[var(--nim-warning)]/30 bg-[var(--nim-warning)]/10">
            <MaterialSymbol icon="warning" size={16} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
            <p className="m-0 text-[13px] text-[var(--nim-text)] leading-snug">
              Target replacement is blocked while this app instance is already using PostgreSQL.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 pt-3">
          <button
            type="button"
            onClick={runMigration}
            disabled={!connectionReady || migrationState === 'running' || replacingActivePostgres}
            className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-primary)] text-white cursor-pointer text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MaterialSymbol icon="database_upload" size={16} />
            {migrationState === 'running' ? 'Migrating...' : 'Migrate PGLite to PostgreSQL'}
          </button>
          {migrationMessage && (
            <span className={`text-xs ${
              migrationState === 'success'
                ? 'text-[var(--nim-success)]'
                : migrationState === 'error'
                ? 'text-[var(--nim-error)]'
                : 'text-[var(--nim-text-muted)]'
            }`}>
              {migrationMessage}
            </span>
          )}
        </div>

        {migrationResult && (
          <div className="mt-4 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--nim-text)] mb-2">
              <MaterialSymbol icon="check_circle" size={16} className="text-[var(--nim-success)]" />
              Migration finished
            </div>
            <div className="text-xs text-[var(--nim-text-muted)] leading-relaxed">
              <div>Rows copied: {migrationResult.rowsCopied.toLocaleString()}</div>
              {migrationResult.snapshotDir && <div>Snapshot: {migrationResult.snapshotDir}</div>}
            </div>
            <details className="mt-2">
              <summary className="text-xs cursor-pointer text-[var(--nim-text-muted)]">Table details</summary>
              <pre className="mt-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap text-[var(--nim-text-muted)]">
                {migrationResult.messages.join('\n')}
              </pre>
            </details>
          </div>
        )}

        {settings.lastMigration && !migrationResult && (
          <p className="mt-3 text-xs text-[var(--nim-text-muted)]">
            Last migration copied {settings.lastMigration.rowsCopied.toLocaleString()} rows on{' '}
            {new Date(settings.lastMigration.completedAt).toLocaleString()}.
          </p>
        )}
      </div>
    </div>
  );
}
