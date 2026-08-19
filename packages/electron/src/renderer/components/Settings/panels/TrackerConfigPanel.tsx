import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import {
  MaterialSymbol,
  globalRegistry,
  parseTrackerYAML,
  type TrackerDataModel,
  type TrackerSharing,
} from '@nimbalyst/runtime';
import { trackerItemCountByTypeAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  describeTrackerArchive,
  describeTrackerPromotion,
  describeTrackerUnarchive,
  isTrackerArchived,
  resolveTrackerPromotionEligibility,
  type TrackerConfirmationCopy,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerLifecycle';
import { ConfirmDialog } from '../../ConfirmDialog/ConfirmDialog';
import { errorNotificationService } from '../../../services/ErrorNotificationService';
import { trackerSyncConfigChangeAtom } from '../../../store/atoms/trackerSync';
import { deriveIssueKeyPrefix, LEGACY_ISSUE_KEY_PREFIX } from '../../../../shared/trackerIssueKeyPrefix';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import { useDialog } from '../../../contexts/DialogContext';
import {
  getTrackerStorageCopy,
} from './trackerConfigUpgrade';
import { TrackerSchemaDriftWarning } from './TrackerSchemaDriftWarning';
import {
  TrackerSchemaChangeConfirm,
  type TrackerSchemaChangePreview,
} from './TrackerSchemaChangeConfirm';
import { LocalKeyPrefixInput, type LocalKeyPrefixConfig } from './LocalKeyPrefixInput';
import {
  TrackerOwnershipChip,
  trackerOwnershipIcon,
  trackerOwnershipLabel,
} from '../../common/TrackerOwnershipChip';
import type { TrackerOwnership } from '../../TrackerMode/trackerNavigationTree';
import { useTrackerTeamOwnership, type TrackerTeam } from '../../TrackerMode/useTrackerTeamMembers';

// ============================================================================
// Types
// ============================================================================

interface TrackerConfigPanelProps {
  workspacePath?: string;
}

interface TrackerTypeConfig {
  model: TrackerDataModel;
  sharing: TrackerSharing;
  draftByDefault: boolean;
}

interface TrackerSchemaOverrideState {
  overridden: boolean;
  filePath?: string;
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

function SchemaOverrideActions({
  model,
  workspacePath,
  override,
  onCustomize,
  onReset,
}: {
  model: TrackerDataModel;
  workspacePath?: string;
  override?: TrackerSchemaOverrideState;
  onCustomize: (model: TrackerDataModel) => void;
  onReset: (model: TrackerDataModel) => void;
}) {
  const isBuiltin = globalRegistry.isBuiltin(model.type);
  if (!workspacePath) return null;

  return (
    <>
      {override?.overridden && (
        <span
          className="px-1.5 py-[1px] rounded bg-[rgba(245,158,11,0.12)] text-[#f59e0b] text-[10px] font-semibold"
          title="Workspace override"
        >
          Override
        </span>
      )}
      <button
        onClick={() => onCustomize(model)}
        className="p-1 rounded text-[var(--nim-text-muted)] hover:text-[var(--nim-primary)] hover:bg-[var(--nim-bg-tertiary)] cursor-pointer"
        title={override?.overridden ? `Edit ${model.displayNamePlural} schema override` : `Customize ${model.displayNamePlural}`}
        data-testid={`customize-tracker-type-${model.type}`}
      >
        <MaterialSymbol icon={override?.overridden ? 'edit' : 'tune'} size={14} />
      </button>
      {isBuiltin && override?.overridden && (
        <button
          onClick={() => onReset(model)}
          className="p-1 rounded text-[var(--nim-text-muted)] hover:text-[#ef4444] hover:bg-[var(--nim-bg-tertiary)] cursor-pointer"
          title={`Reset ${model.displayNamePlural} to default`}
          data-testid={`reset-tracker-type-${model.type}`}
        >
          <MaterialSymbol icon="restart_alt" size={14} />
        </button>
      )}
    </>
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

function getSharingMetaText(tracker: TrackerTypeConfig): string {
  const base = tracker.sharing === 'personal'
    ? 'Only on this machine'
    : tracker.draftByDefault
      ? 'Shared with the team; new items start as drafts'
      : 'Shared with the team';
  // Archived leads, because it is the fact that changes what you can do here.
  // Phrased as retention, never as removal.
  return isTrackerArchived(tracker.model)
    ? `Archived — items kept and searchable, read-only. ${base}`
    : base;
}

/**
 * Promote to team, and archive. Both are confirmed, and both confirmations say
 * plainly what happens — promotion because it is irreversible, archive because
 * "archive" is a word people read as "delete" unless told otherwise.
 */
function TrackerLifecycleActions({
  tracker,
  workspacePath,
  hasTeam,
}: {
  tracker: TrackerTypeConfig;
  workspacePath?: string;
  hasTeam: boolean;
}) {
  const [confirmation, setConfirmation] = useState<
    { kind: 'promote' | 'archive' | 'unarchive'; copy: TrackerConfirmationCopy } | null
  >(null);
  const [pending, setPending] = useState(false);
  const itemCount = useAtomValue(trackerItemCountByTypeAtom(tracker.model.type));
  const archived = isTrackerArchived(tracker.model);
  const promotion = resolveTrackerPromotionEligibility(tracker.model);

  const run = useCallback(async () => {
    if (!workspacePath || !confirmation) return;
    setPending(true);
    try {
      const api = window.electronAPI;
      if (confirmation.kind === 'promote') {
        const result = await api.trackerLifecycle.promoteToTeam({ workspacePath, type: tracker.model.type });
        if (!result?.success) throw new Error(result?.error || 'Could not share this tracker with your team.');
        const { publishedCount = 0, pendingKeyCount = 0 } = result.promotion ?? {};
        errorNotificationService.showInfo(
          `${tracker.model.displayNamePlural} is now your team's`,
          pendingKeyCount > 0
            ? `${publishedCount} item(s) published. ${pendingKeyCount} are waiting on the server for their keys.`
            : `${publishedCount} item(s) published, each with its issue key.`,
          { duration: 4000 },
        );
      } else {
        const archiving = confirmation.kind === 'archive';
        const result = await api.trackerLifecycle.setArchived({
          workspacePath,
          type: tracker.model.type,
          archived: archiving,
        });
        if (!result?.success) throw new Error(result?.error || 'Could not update this tracker.');
        errorNotificationService.showInfo(
          archiving ? `${tracker.model.displayNamePlural} archived` : `${tracker.model.displayNamePlural} unarchived`,
          archiving
            ? 'Every item is kept and stays searchable. They are read-only from now on.'
            : 'Its items can be edited again.',
          { duration: 4000 },
        );
      }
      setConfirmation(null);
    } catch (error) {
      errorNotificationService.showError(
        'Tracker update failed',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPending(false);
    }
  }, [confirmation, tracker.model, workspacePath]);

  return (
    <>
      {hasTeam && promotion.canPromote && (
        <button
          type="button"
          className="tracker-promote-button p-1 rounded hover:bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]"
          title="Share this tracker with your team"
          data-testid="tracker-promote-to-team"
          onClick={() => setConfirmation({
            kind: 'promote',
            copy: describeTrackerPromotion(tracker.model, itemCount),
          })}
        >
          <MaterialSymbol icon="group_add" size={16} />
        </button>
      )}
      <button
        type="button"
        className="tracker-archive-button p-1 rounded hover:bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]"
        title={archived ? 'Unarchive this tracker' : 'Archive this tracker — items are kept'}
        data-testid="tracker-archive-toggle"
        onClick={() => setConfirmation(
          archived
            ? { kind: 'unarchive', copy: describeTrackerUnarchive(tracker.model) }
            : { kind: 'archive', copy: describeTrackerArchive(tracker.model, itemCount) },
        )}
      >
        <MaterialSymbol icon={archived ? 'unarchive' : 'inventory_2'} size={16} />
      </button>
      <ConfirmDialog
        isOpen={confirmation !== null}
        title={confirmation?.copy.title ?? ''}
        message={confirmation?.copy.message ?? ''}
        confirmLabel={pending ? 'Working…' : confirmation?.copy.confirmLabel ?? 'Confirm'}
        cancelLabel="Cancel"
        // Nothing here removes data, so nothing here is styled as danger --
        // archive in particular must not borrow delete's red.
        destructive={false}
        onConfirm={run}
        onCancel={() => setConfirmation(null)}
      />
    </>
  );
}

/**
 * One ownership group of trackers. The same split, headers and chip the tracker
 * sidebar uses, so settings and navigation describe ownership identically —
 * partitioned on `sharing`, the tracker's one ownership axis, which now covers
 * its schema and its items together.
 *
 * `ownership: null` is the solo case: one plain list, with none of the
 * ownership vocabulary a user without a team has no use for.
 */
function TrackerOwnershipGroup({
  ownership,
  teamName,
  trackers,
  description,
  renderActions,
}: {
  ownership: TrackerOwnership | null;
  teamName?: string | null;
  trackers: TrackerTypeConfig[];
  description: string;
  renderActions?: (tracker: TrackerTypeConfig) => React.ReactNode;
}) {
  if (trackers.length === 0) return null;
  const title = ownership === null
    ? 'Trackers'
    : ownership === 'team' ? trackerOwnershipLabel(ownership, teamName) : 'My trackers';

  return (
    <div
      className="tracker-ownership-group provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0"
      data-testid="tracker-ownership-group"
      data-ownership={ownership ?? 'none'}
    >
      <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)] flex items-center gap-2">
        {ownership !== null && (
          <MaterialSymbol
            icon={trackerOwnershipIcon(ownership)}
            size={15}
            className={ownership === 'team' ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'}
          />
        )}
        {title}
      </h4>
      <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
        {description}
      </p>

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
              {ownership !== null && (
                <div className="text-[11px] text-[var(--nim-text-faint)]">
                  {getSharingMetaText(tracker)}
                </div>
              )}
            </div>
            <div className="shrink-0 flex items-center gap-1">
              {renderActions?.(tracker)}
              {ownership !== null && (
                <TrackerOwnershipChip
                  ownership={ownership}
                  teamName={teamName}
                  draftByDefault={tracker.draftByDefault}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function partitionTrackersByOwnership(trackers: TrackerTypeConfig[]) {
  return {
    personal: trackers.filter((tracker) => tracker.sharing !== 'team'),
    team: trackers.filter((tracker) => tracker.sharing === 'team'),
  };
}

/**
 * What editing a team tracker's fields actually does — the question that
 * started this work, answered without opening a config file.
 */
const TEAM_GROUP_DESCRIPTION =
  'Everyone on the team sees the same fields, items, and numbers. Changing this tracker\'s fields changes them for the whole team; the YAML file in .nimbalyst/trackers is a local copy of the team\'s definition.';

const PERSONAL_GROUP_DESCRIPTION =
  'These trackers stay on this machine. They never sync, and nobody on your team can see them.';

/** Solo workspaces get no ownership vocabulary at all — there is nothing to contrast with. */
const SOLO_GROUP_DESCRIPTION =
  'Each tracker keeps its own fields and items, defined in .nimbalyst/trackers and stored on this machine.';

// ============================================================================
// Issue Key Prefix Input
// ============================================================================

/**
 * The prefix is one per project and renaming it changes every future issue key,
 * so it sits on D3's admin side of the line. `readOnly` shows a non-admin what
 * the prefix is without offering the rename. That is presentation only — the
 * TrackerRoom refuses a non-admin's `trackerSetConfig` regardless of what this
 * renders.
 */
function IssueKeyPrefixInput({ value, onChange, readOnly = false }: {
  value: string;
  onChange: (prefix: string) => void;
  readOnly?: boolean;
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
        Team Issue Key Prefix
      </h4>
      <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
        Published tracker items use this shared prefix (e.g., <code className="text-[11px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded">{draft || 'NIM'}-42</code>).
      </p>
      <div className="flex items-center gap-2">
        {readOnly ? (
          <span className="issue-key-prefix-readonly w-24 px-2.5 py-1.5 text-[13px] font-mono text-[var(--nim-text)]">
            {draft || 'NIM'}
          </span>
        ) : (
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
        )}
        <span className="text-[13px] text-[var(--nim-text-faint)]">-123</span>
      </div>
      {error && !readOnly && (
        <p className="text-[11px] text-[var(--nim-error)] mt-1.5">{error}</p>
      )}
      <p className="text-[11px] text-[var(--nim-text-faint)] mt-2">
        {readOnly
          ? 'Only a team admin can change this project\'s prefix.'
          : 'Changing the prefix only affects new items. Existing items keep their current keys.'}
      </p>
    </div>
  );
}

// ============================================================================
// AI Agent Access (per-project tracker-tools opt-out)
// ============================================================================

/**
 * Per-project toggle controlling whether the AI agent gets the tracker MCP
 * tools (`tracker_*`). When off, McpConfigService skips registering the
 * `nimbalyst-trackers` server for this workspace, so the agent can't read or
 * mutate trackers here. Takes effect on the next agent session start.
 */
function AgentAccessSection({ enabled, onChange }: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">
        AI Agent Access
      </h4>
      <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
        Let AI agents read and update trackers in this project. When off, tracker
        tools are removed from the agent entirely. Applies to new agent sessions.
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        data-testid="tracker-agent-access-toggle"
        className="inline-flex items-center gap-2.5 cursor-pointer bg-transparent border-none p-0"
      >
        <span
          className={`relative inline-flex w-9 h-5 rounded-full transition-colors duration-150 ${
            enabled ? 'bg-[var(--nim-primary)]' : 'bg-[var(--nim-bg-tertiary)]'
          }`}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-150 ${
              enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
            }`}
          />
        </span>
        <span className="text-[13px] font-medium text-[var(--nim-text)]">
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </button>
    </div>
  );
}

// ============================================================================
// Admin View
// ============================================================================

function AdminView({
  trackers,
  team,
  workspacePath,
  overrides,
  onCustomizeSchema,
  onResetSchema,
}: {
  trackers: TrackerTypeConfig[];
  team: TrackerTeam | null;
  workspacePath?: string;
  overrides: Record<string, TrackerSchemaOverrideState>;
  onCustomizeSchema: (model: TrackerDataModel) => void;
  onResetSchema: (model: TrackerDataModel) => void;
}) {
  const groups = partitionTrackersByOwnership(trackers);
  const rowActions = (tracker: TrackerTypeConfig) => (
    <>
      <TrackerLifecycleActions
        tracker={tracker}
        workspacePath={workspacePath}
        hasTeam={team !== null}
      />
      <SchemaOverrideActions
        model={tracker.model}
        workspacePath={workspacePath}
        override={overrides[tracker.model.type]}
        onCustomize={onCustomizeSchema}
        onReset={onResetSchema}
      />
      {!globalRegistry.isBuiltin(tracker.model.type) && (
        <DeleteTrackerTypeButton model={tracker.model} workspacePath={workspacePath} />
      )}
    </>
  );

  return (
    <>
      {team === null ? (
        <TrackerOwnershipGroup
          ownership={null}
          trackers={trackers}
          description={SOLO_GROUP_DESCRIPTION}
          renderActions={rowActions}
        />
      ) : (
        <>
          <TrackerOwnershipGroup
            ownership="team"
            teamName={team.name}
            trackers={groups.team}
            description={TEAM_GROUP_DESCRIPTION}
            renderActions={rowActions}
          />
          <TrackerOwnershipGroup
            ownership="personal"
            trackers={groups.personal}
            description={PERSONAL_GROUP_DESCRIPTION}
            renderActions={rowActions}
          />
        </>
      )}

      {/* Inline Note */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="flex items-start gap-1.5 p-2.5 bg-[var(--nim-bg-secondary)] rounded-md text-[11px] text-[var(--nim-text-faint)] leading-relaxed">
          <MaterialSymbol icon="info" size={14} className="shrink-0 mt-0.5" />
          <span>
            Inline trackers (<code className="text-[11px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 py-[1px] rounded">#bug[...]</code>) are always local, regardless of tracker sharing. Only tracked items created from the panel participate in team sync.
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

function MemberView({
  trackers,
  team,
  workspacePath,
}: {
  trackers: TrackerTypeConfig[];
  team: TrackerTeam | null;
  workspacePath?: string;
}) {
  const groups = partitionTrackersByOwnership(trackers);

  return (
    <>
      <TrackerOwnershipGroup
        ownership="team"
        teamName={team?.name}
        trackers={groups.team}
        description={TEAM_GROUP_DESCRIPTION}
      />
      <TrackerOwnershipGroup
        ownership="personal"
        trackers={groups.personal}
        description={PERSONAL_GROUP_DESCRIPTION}
        renderActions={(tracker) => (
          !globalRegistry.isBuiltin(tracker.model.type)
            ? <DeleteTrackerTypeButton model={tracker.model} workspacePath={workspacePath} />
            : null
        )}
      />

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
  const [schemaOverrides, setSchemaOverrides] = useState<Record<string, TrackerSchemaOverrideState>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [issueKeyPrefix, setIssueKeyPrefix] = useState(() => deriveIssueKeyPrefix(workspacePath ?? ''));
  const [localKeyPrefixConfig, setLocalKeyPrefixConfig] = useState<LocalKeyPrefixConfig>(() => ({
    prefix: deriveIssueKeyPrefix(workspacePath ?? ''),
    hasIssuedNumbers: false,
    matchesTeamPrefix: true,
  }));
  const [isSyncConnected, setIsSyncConnected] = useState(false);
  const [agentAccessEnabled, setAgentAccessEnabled] = useState(true);
  const [schemaChangeConfirm, setSchemaChangeConfirm] = useState<
    { model: TrackerDataModel; preview: TrackerSchemaChangePreview } | null
  >(null);
  const [schemaChangePending, setSchemaChangePending] = useState(false);
  const { confirm } = useDialog();
  // Same lookup the sidebar sections use, so both name the team identically.
  const { team } = useTrackerTeamOwnership(workspacePath);

  const refreshSchemaOverrides = useCallback(async (models: TrackerDataModel[]) => {
    if (!workspacePath) {
      setSchemaOverrides({});
      return;
    }
    const entries = await Promise.all(models.map(async (model) => {
      try {
        const state = await (window as any).electronAPI.invoke(
          'tracker-schema:get-override',
          workspacePath,
          model.type,
        ) as TrackerSchemaOverrideState;
        return [model.type, state ?? { overridden: false }] as const;
      } catch {
        return [model.type, { overridden: false }] as const;
      }
    }));
    setSchemaOverrides(Object.fromEntries(entries));
  }, [workspacePath]);

  useEffect(() => {
    // Sharing is schema-owned; there is no per-machine item policy to merge.
    const loadTrackerConfig = async () => {
      if (workspacePath) {
        try {
          const state = await (window as any).electronAPI.invoke('workspace:get-state', workspacePath);
          setIssueKeyPrefix(state?.issueKeyPrefix || LEGACY_ISSUE_KEY_PREFIX);
          setAgentAccessEnabled(state?.trackersEnabled ?? true);
        } catch {
          // Workspace state not available
        }

        // Check team role (per-workspace lookup)
        try {
          const teamResult = await (window as any).electronAPI.team.findForWorkspace(workspacePath);
          if (teamResult.success) {
            if (teamResult.team) {
              // Owners are super-admins; the server's gate accepts them, so a
              // check that only matched 'admin' showed an owner the read-only
              // view for a change the room would have taken.
              setIsAdmin(teamResult.team.role === 'admin' || teamResult.team.role === 'owner');
            } else {
              // No team matched this workspace, so keep local tracker schema management available.
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
        sharing: model.sharing ?? 'personal',
        draftByDefault: model.draftByDefault ?? false,
      }));
      setTrackers(configs);
      void refreshSchemaOverrides(models);
    };

    loadTrackerConfig();

    // Subscribe to registry changes (e.g., custom trackers loaded later)
    const unsubscribe = globalRegistry.onChange(() => {
      const updatedModels = globalRegistry.getAll();
      setTrackers((prev) => {
        const updatedTrackers = updatedModels.map((model) => ({
          model,
          sharing: model.sharing ?? 'personal',
          draftByDefault: model.draftByDefault ?? false,
        }));
        void refreshSchemaOverrides(updatedModels);
        return updatedTrackers;
      });
    });

    return () => {
      unsubscribe();
    };
  }, [refreshSchemaOverrides, workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    void (window as any).electronAPI.invoke('tracker-local-key:get-prefix-config', workspacePath)
      .then((config: LocalKeyPrefixConfig) => {
        if (!cancelled) setLocalKeyPrefixConfig(config);
      })
      .catch(() => {
        // Keep the derived fallback visible if the main-process settings read fails.
      });
    return () => {
      cancelled = true;
    };
  }, [issueKeyPrefix, workspacePath]);

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

  const handleLocalPrefixChange = useCallback(async (prefix: string): Promise<LocalKeyPrefixConfig> => {
    if (!workspacePath) throw new Error('Open a project before changing its local tracker prefix.');
    const config = await (window as any).electronAPI.invoke('tracker-local-key:set-prefix', {
      workspacePath,
      prefix,
    }) as LocalKeyPrefixConfig;
    setLocalKeyPrefixConfig(config);
    return config;
  }, [workspacePath]);

  const handleAgentAccessChange = useCallback((enabled: boolean) => {
    setAgentAccessEnabled(enabled);
    if (workspacePath) {
      (window as any).electronAPI.invoke('workspace:update-state', workspacePath, {
        trackersEnabled: enabled,
      });
    }
  }, [workspacePath]);

  const handleCustomizeSchema = useCallback(async (model: TrackerDataModel) => {
    if (!workspacePath) return;
    try {
      const result = await (window as any).electronAPI.invoke(
        'tracker-schema:customize',
        workspacePath,
        model.type,
      ) as { filePath?: string };
      if (result?.filePath) {
        await (window as any).electronAPI.invoke('workspace:open-file', {
          workspacePath,
          filePath: result.filePath,
        });
      }
      await refreshSchemaOverrides(globalRegistry.getAll());
    } catch (err) {
      window.alert(err instanceof Error ? err.message : `Could not customize ${model.displayNamePlural}.`);
    }
  }, [refreshSchemaOverrides, workspacePath]);

  const applyResetSchema = useCallback(async (model: TrackerDataModel, confirmDestructive: boolean) => {
    try {
      await (window as any).electronAPI.invoke(
        'tracker-schema:reset-override',
        workspacePath,
        model.type,
        { confirmDestructive },
      );
      await refreshSchemaOverrides(globalRegistry.getAll());
    } catch (err) {
      window.alert(err instanceof Error ? err.message : `Could not reset ${model.displayNamePlural}.`);
    }
  }, [refreshSchemaOverrides, workspacePath]);

  /**
   * Resetting an override removes whatever it added, so it is priced by the same
   * guard rail as any other removal — and on a team tracker it resets the type
   * for everyone. An override that only changed presentation classifies as
   * non-destructive and keeps the plain confirm.
   */
  const handleResetSchema = useCallback(async (model: TrackerDataModel) => {
    if (!workspacePath) return;
    let preview: TrackerSchemaChangePreview | null = null;
    try {
      preview = await (window as any).electronAPI.invoke(
        'tracker-schema:preview-change',
        workspacePath,
        model.type,
      ) as TrackerSchemaChangePreview;
    } catch {
      // Pricing is best-effort; fall through to the plain confirm rather than
      // blocking a reset because the item count could not be read.
    }

    if (preview?.classification === 'destructive' && preview.copy) {
      setSchemaChangeConfirm({ model, preview });
      return;
    }

    const approved = await confirm({
      title: `Reset ${model.displayNamePlural}?`,
      message: `Delete the workspace schema override for "${model.displayNamePlural}" and return to the built-in default?`,
      confirmLabel: 'Reset to default',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!approved) return;
    await applyResetSchema(model, false);
  }, [applyResetSchema, confirm, workspacePath]);

  return (
    <div className="tracker-config-panel provider-panel flex flex-col">
      {/* Header */}
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)] flex items-center gap-2">
          Trackers
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          {team
            ? 'Each tracker owns its fields, its items and its numbering, and is either yours or your team\'s.'
            : 'Each tracker owns its fields and its items. Everything here stays on this machine.'}
        </p>
      </div>

      <TrackerStorageInfoBanner />

      <AgentAccessSection
        enabled={agentAccessEnabled}
        onChange={handleAgentAccessChange}
      />

      <TrackerSchemaDriftWarning workspacePath={workspacePath} />

      <LocalKeyPrefixInput
        config={localKeyPrefixConfig}
        teamPrefix={issueKeyPrefix}
        onChange={handleLocalPrefixChange}
      />

      <IssueKeyPrefixInput
        value={issueKeyPrefix}
        onChange={handlePrefixChange}
        readOnly={!isAdmin}
      />

      {isAdmin ? (
        <AdminView
          trackers={trackers}
          team={team}
          workspacePath={workspacePath}
          overrides={schemaOverrides}
          onCustomizeSchema={handleCustomizeSchema}
          onResetSchema={handleResetSchema}
        />
      ) : (
        <MemberView trackers={trackers} team={team} workspacePath={workspacePath} />
      )}

      <TrackerSchemaChangeConfirm
        preview={schemaChangeConfirm?.preview ?? null}
        pending={schemaChangePending}
        onCancel={() => setSchemaChangeConfirm(null)}
        onApply={async () => {
          if (!schemaChangeConfirm) return;
          setSchemaChangePending(true);
          try {
            await applyResetSchema(schemaChangeConfirm.model, true);
            setSchemaChangeConfirm(null);
          } finally {
            setSchemaChangePending(false);
          }
        }}
      />
    </div>
  );
}
