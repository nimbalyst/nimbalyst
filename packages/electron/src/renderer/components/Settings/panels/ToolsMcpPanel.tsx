import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { ToggleSwitch } from '../../GlobalSettings/SettingsToggle';

/**
 * Tools & MCP settings panel — the single place that answers "which tool
 * groups can the agent load, and what does each cost in context tokens".
 *
 * Data comes from the main-process tool-budget snapshot
 * (`mcp-config:get-tool-budget` → toolBudgetService.ts), which measures the
 * same ListTools surfaces the unified MCP server serves. Rows consolidate the
 * existing opt-outs rather than adding new mechanisms: the Trackers toggle
 * writes the same per-workspace `trackersEnabled` state the tracker config
 * panel uses; extension and user-server rows link to their existing panels.
 */

type ToolGroupSource = 'core' | 'first-party' | 'extension' | 'user';

interface ToolGroupBudget {
  configKey: string;
  displayName: string;
  source: ToolGroupSource;
  loadPolicy: 'eager' | 'deferred' | 'conditional' | 'external';
  toolCount: number;
  estTokens: number | null;
  enabled: boolean;
  lockedOn: boolean;
}

interface ToolBudgetSnapshot {
  groups: ToolGroupBudget[];
  eagerEstTokens: number;
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
  nimbalyst: 'Host glue the app needs (questions, commit proposal, screenshots, session metadata)',
  'nimbalyst-host': 'App settings, session context, and child-session orchestration',
  'nimbalyst-trackers': 'Bug, task, plan, and decision tracking',
  'nimbalyst-situational': 'Voice mode, collab documents, and feedback',
  'nimbalyst-extension-dev': 'Extension development and debugging (developer mode)',
};

function formatTokens(estTokens: number | null): string {
  if (estTokens === null) return '—';
  if (estTokens >= 1000) return `~${(estTokens / 1000).toFixed(1)}k`;
  return `~${estTokens}`;
}

function PolicyBadge({ policy }: { policy: ToolGroupBudget['loadPolicy'] }) {
  const label =
    policy === 'eager' ? 'Always loaded'
    : policy === 'conditional' ? 'Conditional'
    : policy === 'external' ? 'External'
    : 'Loads on demand';
  const style =
    policy === 'eager'
      ? 'bg-[rgba(245,158,11,0.15)] text-[#F59E0B] border-[rgba(245,158,11,0.3)]'
      : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] border-[var(--nim-border)]';
  return (
    <span className={`policy-badge text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap ${style}`}>
      {label}
    </span>
  );
}

function TokenBadge({ estTokens }: { estTokens: number | null }) {
  return (
    <span
      className="token-badge text-[11px] tabular-nums text-[var(--nim-text-muted)] min-w-[48px] text-right"
      title={estTokens === null ? 'Tool definitions live in the external server; cost unknown until it connects' : 'Estimated context tokens when this group’s tool definitions are loaded'}
    >
      {formatTokens(estTokens)}
    </span>
  );
}

export function ToolsMcpPanel({
  workspacePath,
  onNavigateToCategory,
}: {
  workspacePath?: string;
  onNavigateToCategory?: (category: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ToolBudgetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackersEnabled, setTrackersEnabled] = useState(true);

  const loadSnapshot = useCallback(async () => {
    try {
      const result = await (window as any).electronAPI.invoke('mcp-config:get-tool-budget', workspacePath);
      setSnapshot(result);
      const trackers = result?.groups?.find((g: ToolGroupBudget) => g.configKey === 'nimbalyst-trackers');
      if (trackers) setTrackersEnabled(trackers.enabled);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tool information');
    }
  }, [workspacePath]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const handleTrackersToggle = useCallback((enabled: boolean) => {
    setTrackersEnabled(enabled);
    if (workspacePath) {
      // Same per-workspace state the Trackers config panel writes; the session
      // MCP config reads it fresh on the next message.
      (window as any).electronAPI.invoke('workspace:update-state', workspacePath, {
        trackersEnabled: enabled,
      });
    }
  }, [workspacePath]);

  const groups = snapshot?.groups ?? [];
  const firstParty = groups.filter((g) => g.source === 'core' || g.source === 'first-party');
  const extensions = groups.filter((g) => g.source === 'extension');
  const userServers = groups.filter((g) => g.source === 'user');

  const renderRow = (group: ToolGroupBudget) => {
    const isTrackers = group.configKey === 'nimbalyst-trackers';
    const description =
      GROUP_DESCRIPTIONS[group.configKey] ??
      (group.source === 'extension' ? `${group.toolCount} tools from the ${group.displayName} extension` : 'User-added MCP server');
    const enabled = isTrackers ? trackersEnabled : group.enabled;

    return (
      <div
        key={group.configKey}
        className={`tool-group-row flex items-center justify-between gap-4 py-2.5 px-3 border-b border-[var(--nim-border)] last:border-b-0 ${enabled ? '' : 'opacity-55'}`}
        data-testid={`tool-group-${group.configKey}`}
      >
        <div className="tool-group-main min-w-0">
          <div className="tool-group-name flex items-center gap-1.5 text-sm font-medium text-[var(--nim-text)]">
            <span className="truncate">{group.displayName}</span>
            {group.lockedOn && (
              <MaterialSymbol
                icon="lock"
                size={13}
                className="text-[var(--nim-text-faint)]"
                title="Required — the app's own tools; cannot be disabled"
              />
            )}
            {isTrackers && workspacePath && (
              <span className="scope-chip text-[10px] px-1.5 py-px rounded bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text-faint)]">
                This workspace
              </span>
            )}
          </div>
          <div className="tool-group-desc text-xs text-[var(--nim-text-muted)] truncate">{description}</div>
        </div>
        <div className="tool-group-meta flex items-center gap-2.5 shrink-0">
          {group.toolCount > 0 && (
            <span className="tool-count text-[11px] text-[var(--nim-text-faint)] tabular-nums whitespace-nowrap">
              {group.toolCount} tools
            </span>
          )}
          <TokenBadge estTokens={group.estTokens} />
          <PolicyBadge policy={group.loadPolicy} />
          {group.lockedOn ? (
            <ToggleSwitch checked disabled onChange={() => undefined} />
          ) : isTrackers ? (
            <ToggleSwitch checked={trackersEnabled} onChange={handleTrackersToggle} disabled={!workspacePath} />
          ) : group.source === 'extension' ? (
            <button
              className="manage-link text-xs text-[var(--nim-primary)] hover:underline whitespace-nowrap"
              onClick={() => onNavigateToCategory?.('installed-extensions')}
            >
              Manage
            </button>
          ) : group.source === 'user' ? (
            <button
              className="manage-link text-xs text-[var(--nim-primary)] hover:underline whitespace-nowrap"
              onClick={() => onNavigateToCategory?.('mcp-servers')}
            >
              Manage
            </button>
          ) : (
            // Non-toggleable first-party groups (host / situational / extension-dev):
            // deferred, so they cost nothing until the agent actually needs them.
            <span className="w-11" />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="tools-mcp-panel max-w-[720px]">
      <h2 className="text-lg font-semibold text-[var(--nim-text)] mb-1">Tools &amp; MCP</h2>
      <p className="text-[13px] text-[var(--nim-text-muted)] mb-5">
        See what the agent&apos;s tools cost in context tokens and control which groups it can load.
      </p>

      {error && (
        <div className="tools-mcp-error text-sm text-[var(--nim-error,#ff4444)] mb-4">{error}</div>
      )}

      {snapshot && (
        <div className="baseline-card flex items-start gap-3 py-3 px-4 mb-6 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
          <MaterialSymbol icon="info" size={18} className="text-[var(--nim-text-muted)] mt-0.5 shrink-0" />
          <div className="text-[13px] text-[var(--nim-text)] leading-relaxed">
            Every session starts with only the Core tools loaded
            (<span className="tabular-nums font-medium">{formatTokens(snapshot.eagerEstTokens)} tokens</span>).
            All other groups stay out of the context window until the agent actually needs them,
            so their costs below are only paid on demand. The live breakdown for a running session
            is on the token meter in the AI panel.
          </div>
        </div>
      )}

      <div className="section-label text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] mb-2">
        Built-in tool groups
      </div>
      <div className="group-list border border-[var(--nim-border)] rounded-lg mb-6 bg-[var(--nim-bg-secondary)]">
        {firstParty.map(renderRow)}
      </div>

      {extensions.length > 0 && (
        <>
          <div className="section-label text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] mb-2">
            Extension tool groups
          </div>
          <div className="group-list border border-[var(--nim-border)] rounded-lg mb-6 bg-[var(--nim-bg-secondary)]">
            {extensions.map(renderRow)}
          </div>
        </>
      )}

      {userServers.length > 0 && (
        <>
          <div className="section-label text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] mb-2">
            Your MCP servers <span className="normal-case font-normal">(.mcp.json)</span>
          </div>
          <div className="group-list border border-[var(--nim-border)] rounded-lg mb-6 bg-[var(--nim-bg-secondary)]">
            {userServers.map(renderRow)}
          </div>
        </>
      )}

      <div className="footer-note text-[11.5px] text-[var(--nim-text-faint)]">
        Changes apply to your next message — no restart needed.
      </div>
    </div>
  );
}
