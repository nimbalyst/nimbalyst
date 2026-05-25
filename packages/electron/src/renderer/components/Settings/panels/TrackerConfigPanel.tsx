import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import {
  MaterialSymbol,
  globalRegistry,
  parseTrackerYAML,
  type TrackerDataModel,
  type TrackerSyncMode,
} from '@nimbalyst/runtime';
import { trackerItemCountByTypeAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { trackerSyncConfigChangeAtom } from '../../../store/atoms/trackerSync';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import { useDialog } from '../../../contexts/DialogContext';
import {
  buildTrackerUpgradeConfirmOptions,
  canUpgradeTrackerMode,
  getTrackerStorageCopy,
  requiresTrackerUpgradeConfirmation,
} from './trackerConfigUpgrade';

// ============================================================================
// Types
// ============================================================================

interface TrackerConfigPanelProps {
  workspacePath?: string;
}

interface TrackerTypeConfig {
  model: TrackerDataModel;
  syncMode: TrackerSyncMode;
}

const ISSUE_KEY_PREFIX_REGEX = /^[A-Z]{2,5}$/;

// ============================================================================
// Sub-components
// ============================================================================

/** Small component so each row subscribes to its own count atom */
function TrackerTypeCount({ type }: { type: string }) {
  const count = useAtomValue(trackerItemCountByTypeAtom(type));
  return <>{count}</>;
}

/** Find the YAML file in .nimbalyst/trackers whose parsed `type` matches and delete it. */
async function deleteCustomTrackerYAML(workspacePath: string, type: string): Promise<boolean> {
  const api = (window as any).electronAPI;
  const trackersDir = `${workspacePath}/.nimbalyst/trackers`;
  let files: Array<{ type: string; name: string }> = [];
  try {
    files = await api.getFolderContents(trackersDir);
  } catch {
    return false;
  }
  const yamlFiles = files.filter(
    (f) => f.type === 'file' && (f.name.endsWith('.yaml') || f.name.endsWith('.yml'))
  );
  for (const file of yamlFiles) {
    const filePath = `${trackersDir}/${file.name}`;
    try {
      const result = await api.readFileContent(filePath);
      if (!result?.success || !result.content) continue;
      const model = parseTrackerYAML(result.content);
      if (model.type === type) {
        await api.deleteFile(filePath);
        return true;
      }
    } catch {
      // Skip unparseable files
    }
  }
  return false;
}

/**
 * Trash button that subscribes to the count atom so it can block deletion when items exist.
 * Rendered only for non-builtin tracker types.
 */
function DeleteTrackerTypeButton({
  model,
  workspacePath,
}: {
  model: TrackerDataModel;
  workspacePath?: string;
}) {
  const count = useAtomValue(trackerItemCountByTypeAtom(model.type));

  const handleClick = useCallback(async () => {
    if (!workspacePath) return;
    if (count > 0) {
      window.alert(
        `Cannot delete "${model.displayNamePlural}": ${count} item${count === 1 ? '' : 's'} of this type still exist. Delete those items first.`
      );
      return;
    }
    if (!window.confirm(`Delete tracker type "${model.displayNamePlural}"? This cannot be undone.`)) {
      return;
    }
    const fileDeleted = await deleteCustomTrackerYAML(workspacePath, model.type);
    if (!fileDeleted) {
      window.alert(
        `Could not find the source YAML file for "${model.displayNamePlural}" in .nimbalyst/trackers/. The tracker type was not deleted.`
      );
      return;
    }
    globalRegistry.unregister(model.type);
  }, [count, model.displayNamePlural, model.type, workspacePath]);

  return (
    <button
      onClick={handleClick}
      className="p-1 rounded text-[var(--nim-text-muted)] hover:text-[#ef4444] hover:bg-[var(--nim-bg-tertiary)] cursor-pointer"
      title={`Delete tracker type "${model.displayNamePlural}"`}
      data-testid={`delete-tracker-type-${model.type}`}
    >
      <MaterialSymbol icon="delete" size={14} />
    </button>
  );
}

function SyncModeToggle({ mode, onChange }: {
  mode: TrackerSyncMode;
  onChange: (mode: TrackerSyncMode) => void;
}) {
  const options: { value: TrackerSyncMode; label: string }[] = [
    { value: 'local', label: 'Local' },
    { value: 'shared', label: 'Shared' },
    { value: 'hybrid', label: 'Hybrid' },
  ];

  return (
    <div className="flex bg-[var(--nim-bg)] border border-[var(--nim-bg-tertiary)] rounded-md overflow-hidden">
      {options.map((opt) => {
        const isActive = mode === opt.value;
        let activeClass = '';
        if (isActive) {
          if (opt.value === 'local') activeClass = 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]';
          else if (opt.value === 'shared') activeClass = 'bg-[rgba(96,165,250,0.2)] text-[var(--nim-primary)]';
          else activeClass = 'bg-[rgba(167,139,250,0.2)] text-[#a78bfa]';
        }

        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-1 text-[11px] font-medium cursor-pointer border-none whitespace-nowrap transition-all duration-150 ${
              isActive
                ? activeClass
                : 'bg-transparent text-[var(--nim-text-disabled)]'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SyncBadge({ mode }: { mode: TrackerSyncMode }) {
  if (mode === 'shared') {
    return (
      <span className="inline-flex items-center gap-1 px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold bg-[rgba(96,165,250,0.15)] text-[var(--nim-primary)]">
        <MaterialSymbol icon="share" size={8} />
        Shared
      </span>
    );
  }
  if (mode === 'hybrid') {
    return (
      <span className="inline-flex items-center gap-1 px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold bg-[rgba(167,139,250,0.15)] text-[#a78bfa]">
        Hybrid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold bg-[rgba(180,180,180,0.1)] text-[var(--nim-text-faint)]">
      Local
    </span>
  );
}

function TrackerIcon({ color, icon }: { color: string; icon: string }) {
  return (
    <div
      className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
      style={{ background: `${color}20` }}
    >
      <MaterialSymbol icon={icon} size={16} style={{ color }} fill />
    </div>
  );
}

function TrackerStorageInfoBanner() {
  return (
    <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <div className="flex items-start gap-2.5 p-3 bg-[rgba(96,165,250,0.08)] border border-[rgba(96,165,250,0.2)] rounded-lg">
        <MaterialSymbol icon="storage" size={14} className="text-[var(--nim-primary)] shrink-0 mt-0.5" />
        <div className="text-[12px] text-[var(--nim-text-muted)] leading-relaxed">
          {getTrackerStorageCopy()}
        </div>
      </div>
    </div>
  );
}

function getSyncMetaText(mode: TrackerSyncMode): string {
  switch (mode) {
    case 'shared': return 'Visible to all team members';
    case 'local': return 'Only visible to you';
    case 'hybrid': return 'Per-item sharing choice';
  }
}

// ============================================================================
// Issue Key Prefix Input
// ============================================================================

function IssueKeyPrefixInput({ value, onChange }: {
  value: string;
  onChange: (prefix: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleBlur = useCallback(() => {
    const upper = draft.toUpperCase();
    if (!ISSUE_KEY_PREFIX_REGEX.test(upper)) {
      setError('Must be 2-5 uppercase letters');
      return;
    }
    setError('');
    if (upper !== value) {
      onChange(upper);
    }
  }, [draft, value, onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  return (
    <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
        Issue Key Prefix
      </h4>
      <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
        New tracker items will use this prefix (e.g., <code className="text-[11px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded">{draft || 'NIM'}-42</code>).
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value.toUpperCase());
            setError('');
          }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          maxLength={5}
          placeholder="NIM"
          className="w-24 px-2.5 py-1.5 text-[13px] font-mono bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors"
        />
        <span className="text-[13px] text-[var(--nim-text-faint)]">-123</span>
      </div>
      {error && (
        <p className="text-[11px] text-[var(--nim-error)] mt-1.5">{error}</p>
      )}
      <p className="text-[11px] text-[var(--nim-text-faint)] mt-2">
        Changing the prefix only affects new items. Existing items keep their current keys.
      </p>
    </div>
  );
}

// ============================================================================
// Admin View
// ============================================================================

function AdminView({ trackers, onSyncModeChange, workspacePath }: {
  trackers: TrackerTypeConfig[];
  onSyncModeChange: (type: string, mode: TrackerSyncMode) => void;
  workspacePath?: string;
}) {
  return (
    <>
      {/* Team Sync Policy Section */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)] flex items-center gap-2">
          Team Sync Policy
          <span className="px-[7px] py-[2px] rounded-[10px] text-[10px] font-semibold bg-[rgba(96,165,250,0.15)] text-[var(--nim-primary)]">
            Admin
          </span>
        </h4>
        <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
          Control how each tracker type syncs with the team. Changes apply to all members.
        </p>

        {/* Info Banner */}
        <div className="flex items-start gap-2.5 p-3 bg-[rgba(96,165,250,0.08)] border border-[rgba(96,165,250,0.2)] rounded-lg mb-3">
          <MaterialSymbol icon="info" size={14} className="text-[var(--nim-primary)] shrink-0 mt-0.5" />
          <div className="text-[12px] text-[var(--nim-text-muted)] leading-relaxed">
            <strong className="text-[var(--nim-primary)] font-semibold">Shared</strong> items sync to all team members in real time.{' '}
            <strong className="text-[var(--nim-text-muted)] font-semibold">Local</strong> items stay on your machine only.{' '}
            <strong className="text-[#a78bfa] font-semibold">Hybrid</strong> lets each item be shared or local individually.
          </div>
        </div>

        {/* Tracker Type List */}
        <div className="bg-[var(--nim-bg-secondary)] rounded-lg overflow-hidden">
          {trackers.map((tracker) => (
            <div
              key={tracker.model.type}
              className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[var(--nim-bg)] last:border-b-0"
            >
              <TrackerIcon color={tracker.model.color} icon={tracker.model.icon} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--nim-text)] flex items-center gap-1.5">
                  {tracker.model.displayNamePlural}
                  <span className="px-1.5 py-[1px] rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] text-[10px] font-semibold">
                    <TrackerTypeCount type={tracker.model.type} />
                  </span>
                </div>
                <div className="text-[11px] text-[var(--nim-text-faint)]">
                  {getSyncMetaText(tracker.syncMode)}
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-1">
                <SyncModeToggle
                  mode={tracker.syncMode}
                  onChange={(mode) => onSyncModeChange(tracker.model.type, mode)}
                />
                {!globalRegistry.isBuiltin(tracker.model.type) && (
                  <DeleteTrackerTypeButton model={tracker.model} workspacePath={workspacePath} />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Inline Note */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="flex items-start gap-1.5 p-2.5 bg-[var(--nim-bg-secondary)] rounded-md text-[11px] text-[var(--nim-text-faint)] leading-relaxed">
          <MaterialSymbol icon="info" size={14} className="shrink-0 mt-0.5" />
          <span>
            Inline trackers (<code className="text-[11px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded">#bug[...]</code>) are always local, regardless of sync policy. Only tracked items created from the panel participate in sync.
          </span>
        </div>
      </div>

      {/* Promote Banner */}
      <div className="provider-panel-section py-4">
        <div className="flex items-center gap-2 p-3 bg-[rgba(167,139,250,0.08)] border border-[rgba(167,139,250,0.15)] rounded-lg">
          <MaterialSymbol icon="arrow_upward" size={16} className="text-[#a78bfa] shrink-0" />
          <div className="flex-1 text-[12px] text-[var(--nim-text-muted)] leading-snug">
            <strong className="text-[#a78bfa]">Promote inline items</strong> to tracked items to share them with the team. Right-click any inline tracker and select "Promote to Tracked Item."
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Member View
// ============================================================================

function MemberView({ trackers, workspacePath }: { trackers: TrackerTypeConfig[]; workspacePath?: string }) {
  const sharedTrackers = trackers.filter((t) => t.syncMode !== 'local');
  const localTrackers = trackers.filter((t) => t.syncMode === 'local');

  return (
    <>
      {/* Team Trackers (read-only) */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)] flex items-center gap-2">
          Team Trackers
          <span className="text-[11px] font-normal text-[var(--nim-text-faint)]">Managed by admin</span>
        </h4>
        <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
          These tracker types are configured by your team admin. Shared items sync in real time.
        </p>

        <div className="bg-[var(--nim-bg-secondary)] rounded-lg overflow-hidden">
          {sharedTrackers.map((tracker) => (
            <div
              key={tracker.model.type}
              className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[var(--nim-bg)] last:border-b-0"
            >
              <TrackerIcon color={tracker.model.color} icon={tracker.model.icon} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--nim-text)]">
                  {tracker.model.displayNamePlural}
                </div>
                <div className="text-[11px] text-[var(--nim-text-faint)]">
                  <TrackerTypeCount type={tracker.model.type} /> items synced with team
                </div>
              </div>
              <div className="shrink-0">
                <SyncBadge mode={tracker.syncMode} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Local Trackers */}
      {localTrackers.length > 0 && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)] flex items-center gap-2">
            Your Local Trackers
            <span className="text-[11px] font-normal text-[var(--nim-text-faint)]">Only on this machine</span>
          </h4>
          <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
            These tracker types are local to your workspace. They never sync and are not visible to your team.
          </p>

          <div className="bg-[var(--nim-bg-secondary)] rounded-lg overflow-hidden">
            {localTrackers.map((tracker) => (
              <div
                key={tracker.model.type}
                className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[var(--nim-bg)] last:border-b-0"
              >
                <TrackerIcon color={tracker.model.color} icon={tracker.model.icon} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-[var(--nim-text)]">
                    {tracker.model.displayNamePlural}
                  </div>
                  <div className="text-[11px] text-[var(--nim-text-faint)]">
                    <TrackerTypeCount type={tracker.model.type} /> items, local only
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <SyncBadge mode="local" />
                  {!globalRegistry.isBuiltin(tracker.model.type) && (
                    <DeleteTrackerTypeButton model={tracker.model} workspacePath={workspacePath} />
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3">
            <button className="inline-flex items-center gap-1 px-2.5 py-1 bg-transparent border border-[var(--nim-border)] rounded text-[var(--nim-text-muted)] text-[11px] cursor-pointer hover:bg-[var(--nim-bg-hover)]">
              <MaterialSymbol icon="add" size={12} />
              Add Custom Tracker
            </button>
          </div>
        </div>
      )}

      {/* Inline Note */}
      <div className="provider-panel-section py-4">
        <div className="flex items-start gap-1.5 p-2.5 bg-[var(--nim-bg-secondary)] rounded-md text-[11px] text-[var(--nim-text-faint)] leading-relaxed">
          <MaterialSymbol icon="info" size={14} className="shrink-0 mt-0.5" />
          <span>
            Inline trackers (<code className="text-[11px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded">#bug[...]</code>) in your documents are always local. Promote them to tracked items to share with the team.
          </span>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// TrackerConfigPanel
// ============================================================================

export function TrackerConfigPanel({ workspacePath }: TrackerConfigPanelProps) {
  const [trackers, setTrackers] = useState<TrackerTypeConfig[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [issueKeyPrefix, setIssueKeyPrefix] = useState('NIM');
  const [isSyncConnected, setIsSyncConnected] = useState(false);
  const { confirm } = useDialog();

  useEffect(() => {
    // Load saved sync policies from workspace state, then merge with registry
    const loadPolicies = async () => {
      let savedPolicies: Record<string, TrackerSyncMode> = {};
      if (workspacePath) {
        try {
          const state = await (window as any).electronAPI.invoke('workspace:get-state', workspacePath);
          savedPolicies = state?.trackerSyncPolicies ?? {};
          if (state?.issueKeyPrefix) {
            setIssueKeyPrefix(state.issueKeyPrefix);
          }
        } catch {
          // Workspace state not available
        }

        // Check team role (per-workspace lookup)
        try {
          const teamResult = await (window as any).electronAPI.team.findForWorkspace(workspacePath);
          if (teamResult.success) {
            if (teamResult.team) {
              setIsAdmin(teamResult.team.role === 'admin');
            } else {
              // No team matched this workspace, so keep local tracker policy management available.
              setIsAdmin(true);
            }
          }
        } catch {
          // Leave admin gating closed on lookup error.
        }

        // Check if tracker sync is connected (for determining where to save prefix)
        try {
          const syncStatus = await (window as any).electronAPI.invoke('tracker-sync:get-status', { workspacePath });
          setIsSyncConnected(syncStatus?.active ?? false);
        } catch {
          // Not connected
        }
      }

      const models = globalRegistry.getAll();
      const configs: TrackerTypeConfig[] = models.map((model) => ({
        model,
        syncMode: savedPolicies[model.type] ?? model.sync?.mode ?? 'local',
      }));
      setTrackers(configs);
    };

    loadPolicies();

    // Subscribe to registry changes (e.g., custom trackers loaded later)
    const unsubscribe = globalRegistry.onChange(() => {
      const updatedModels = globalRegistry.getAll();
      setTrackers((prev) => {
        const existingModes = new Map(prev.map((t) => [t.model.type, t.syncMode]));
        return updatedModels.map((model) => ({
          model,
          syncMode: existingModes.get(model.type) ?? model.sync?.mode ?? 'local',
        }));
      });
    });

    return () => {
      unsubscribe();
    };
  }, [workspacePath]);

  // React to `tracker-sync:config-changed` events broadcast by main. The IPC
  // event is handled centrally in store/listeners/trackerSyncListeners.ts
  // which writes trackerSyncConfigChangeAtom; we apply only updates whose
  // workspacePath matches ours, skipping the initial-mount value so a stale
  // config update from before this panel opened doesn't clobber the fresh
  // value loaded from workspace state.
  const trackerSyncConfigChange = useAtomValue(trackerSyncConfigChangeAtom);
  const initialTrackerSyncConfigChangeRef = useRef(trackerSyncConfigChange);
  useEffect(() => {
    if (trackerSyncConfigChange === initialTrackerSyncConfigChangeRef.current) return;
    if (!trackerSyncConfigChange) return;
    const { workspacePath: eventPath, config } = trackerSyncConfigChange.payload;
    if (eventPath !== workspacePath || !config.issueKeyPrefix) return;
    setIssueKeyPrefix(config.issueKeyPrefix);
  }, [trackerSyncConfigChange, workspacePath]);

  const handlePrefixChange = useCallback((prefix: string) => {
    setIssueKeyPrefix(prefix);
    if (workspacePath) {
      // Always persist to workspace settings (used for local-only trackers)
      (window as any).electronAPI.invoke('workspace:update-state', workspacePath, {
        issueKeyPrefix: prefix,
      });
      // If sync is connected, also send to server
      if (isSyncConnected) {
        (window as any).electronAPI.invoke('tracker-sync:set-config', {
          workspacePath,
          key: 'issueKeyPrefix',
          value: prefix,
        });
      }
    }
  }, [workspacePath, isSyncConnected]);

  const handleSyncModeChange = useCallback(async (type: string, mode: TrackerSyncMode) => {
    const tracker = trackers.find((entry) => entry.model.type === type);
    if (!tracker || tracker.syncMode === mode) {
      return;
    }

    if (!canUpgradeTrackerMode(tracker.syncMode, mode, isAdmin)) {
      return;
    }

    if (requiresTrackerUpgradeConfirmation(tracker.syncMode, mode)) {
      const approved = await confirm(
        buildTrackerUpgradeConfirmOptions(tracker.model.displayNamePlural, mode)
      );
      if (!approved) {
        return;
      }
    }

    setTrackers((prev) =>
      prev.map((t) =>
        t.model.type === type ? { ...t, syncMode: mode } : t
      )
    );

    // Persist to workspace state
    if (workspacePath) {
      (window as any).electronAPI.invoke('workspace:update-state', workspacePath, {
        trackerSyncPolicies: { [type]: mode },
      });
    }
  }, [confirm, isAdmin, trackers, workspacePath]);

  return (
    <div className="tracker-config-panel provider-panel flex flex-col">
      {/* Header */}
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)] flex items-center gap-2">
          Trackers
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          {isAdmin
            ? 'Configure which tracker types are shared with the team and manage local-only trackers.'
            : 'View team-shared tracker types and manage your local trackers.'}
        </p>
      </div>

      <TrackerStorageInfoBanner />

      <IssueKeyPrefixInput
        value={issueKeyPrefix}
        onChange={handlePrefixChange}
      />

      {isAdmin ? (
        <AdminView
          trackers={trackers}
          onSyncModeChange={handleSyncModeChange}
          workspacePath={workspacePath}
        />
      ) : (
        <MemberView trackers={trackers} workspacePath={workspacePath} />
      )}
    </div>
  );
}
