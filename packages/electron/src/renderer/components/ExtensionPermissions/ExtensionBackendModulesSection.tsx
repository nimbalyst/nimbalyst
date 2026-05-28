/**
 * Per-extension settings section: shows each declared backend module, its
 * declared permissions, current grant state (per scope), and revoke buttons.
 *
 * Lives in the Installed Extensions detail panel. Phase 4 lands this for
 * extensions that declare `contributions.backendModules` - currently zero
 * extensions ship one, but the surface is in place for Jupyter and future
 * privileged extensions.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { extensionPermissionHostStateVersionAtom } from '../../store/atoms/extensionPermissions';

type RiskTier = 'low' | 'elevated' | 'high';

interface BackendModuleDecl {
  id: string;
  entry: string;
  runtime: 'utility-process' | 'worker-thread';
  permissions: string[];
  enablement: { default: 'disabled'; promptOn: 'firstUse'; purpose: string };
}

interface ExtensionBackendModulesSectionProps {
  extensionId: string;
  modules: BackendModuleDecl[];
  workspacePath?: string;
}

interface PermissionDescriptor {
  id: string;
  label: string;
  description: string;
  risk: RiskTier;
}

interface ModuleSnapshot {
  workspaceGrantedPermissions: Set<string>;
  globalGrantedPermissions: Set<string>;
  hostState?: unknown;
}

const RISK_TEXT: Record<RiskTier, string> = {
  high: 'text-[var(--nim-error)]',
  elevated: 'text-[var(--nim-warning)]',
  low: 'text-[var(--nim-text-muted)]',
};

export const ExtensionBackendModulesSection: React.FC<ExtensionBackendModulesSectionProps> = ({
  extensionId,
  modules,
  workspacePath,
}) => {
  const [descriptors, setDescriptors] = useState<PermissionDescriptor[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, ModuleSnapshot>>({});
  const [busyModuleId, setBusyModuleId] = useState<string | null>(null);
  const hostStateVersion = useAtomValue(extensionPermissionHostStateVersionAtom);

  const descriptorById = useMemo(() => {
    const map = new Map<string, PermissionDescriptor>();
    for (const d of descriptors) map.set(d.id, d);
    return map;
  }, [descriptors]);

  const api = window.electronAPI?.extensions?.permissions;

  const reload = useCallback(async () => {
    if (!api) return;
    const [effective, descs, hostState] = await Promise.all([
      api.listEffective(workspacePath),
      api.listDescriptors(),
      api.listHostState(),
    ]);
    setDescriptors(descs);
    const next: Record<string, ModuleSnapshot> = {};
    for (const mod of modules) {
      const ws = new Set<string>();
      const global = new Set<string>();
      for (const row of effective) {
        if (row.extensionId !== extensionId || row.moduleId !== mod.id) continue;
        if (row.scope === 'workspace') ws.add(row.permissionId);
        else global.add(row.permissionId);
      }
      const handle = hostState.find(
        (h) =>
          h.extensionId === extensionId &&
          h.moduleId === mod.id &&
          h.workspacePath === workspacePath
      );
      next[mod.id] = {
        workspaceGrantedPermissions: ws,
        globalGrantedPermissions: global,
        hostState: handle?.state,
      };
    }
    setSnapshots(next);
  }, [extensionId, modules, workspacePath]);

  useEffect(() => {
    if (!api) return;
    // hostStateVersion bumps on every host state-changed event (filtered
    // central-listener-side to one shared subscription). Listing as a dep
    // re-runs the reload when any module's status flips.
    void reload();
  }, [api, hostStateVersion, reload]);

  const handleRevoke = useCallback(
    async (moduleId: string, scope: 'workspace' | 'global') => {
      if (!api) return;
      if (!workspacePath && scope === 'workspace') return;
      setBusyModuleId(moduleId);
      try {
        await api.revokeModule({
          extensionId,
          moduleId,
          scope,
          workspacePath: workspacePath ?? '',
        });
        await reload();
      } finally {
        setBusyModuleId(null);
      }
    },
    [api, extensionId, reload, workspacePath]
  );

  if (modules.length === 0) return null;
  if (!api) {
    return (
      <div className="ext-backend-modules-section mb-5 text-xs text-[var(--nim-text-faint)] italic">
        Privileged capabilities API not loaded yet. Restart Nimbalyst to manage backend module permissions.
      </div>
    );
  }

  return (
    <div className="ext-backend-modules-section mb-5">
      <div className="text-xs font-semibold text-[var(--nim-text-muted)] uppercase tracking-wide mb-2.5">
        Privileged Capabilities
      </div>

      <div className="flex flex-col gap-3">
        {modules.map((mod) => {
          const snap = snapshots[mod.id];
          const wsEnabled =
            snap !== undefined &&
            mod.permissions.every((p) => snap.workspaceGrantedPermissions.has(p));
          const globalEnabled =
            snap !== undefined &&
            mod.permissions.every((p) => snap.globalGrantedPermissions.has(p));

          const stateDescription = describeHostState(snap?.hostState);

          return (
            <div
              key={mod.id}
              className="ext-backend-module bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md p-3"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--nim-text)]">
                  <MaterialSymbol icon="memory" size={16} />
                  {mod.id}
                  <span className="text-xs text-[var(--nim-text-faint)] font-mono">
                    ({mod.runtime})
                  </span>
                </div>
                {stateDescription && (
                  <span
                    className={`ext-backend-module-state text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${stateDescription.classes}`}
                  >
                    {stateDescription.label}
                  </span>
                )}
              </div>

              <p className="m-0 mb-3 text-xs text-[var(--nim-text-muted)] leading-relaxed">
                {mod.enablement.purpose}
              </p>

              <div className="ext-backend-module-permissions mb-3 flex flex-col gap-1.5">
                {mod.permissions.map((permId) => {
                  const d = descriptorById.get(permId);
                  if (!d) {
                    return (
                      <div
                        key={permId}
                        className="text-xs text-[var(--nim-text-faint)] italic"
                      >
                        Unknown permission: {permId}
                      </div>
                    );
                  }
                  return (
                    <div key={permId} className="flex items-start gap-2 text-xs">
                      <span className={`mt-px ${RISK_TEXT[d.risk]}`}>
                        <MaterialSymbol icon="shield" size={12} />
                      </span>
                      <div className="flex-1">
                        <span className="font-medium text-[var(--nim-text)]">{d.label}</span>
                        <span className="ml-1 text-[var(--nim-text-muted)]">
                          - {d.description}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="ext-backend-module-grants flex flex-wrap items-center gap-2">
                <ScopePill
                  label="This workspace"
                  enabled={wsEnabled}
                  disabledReason={workspacePath ? undefined : 'No workspace open'}
                  busy={busyModuleId === mod.id}
                  onRevoke={() => handleRevoke(mod.id, 'workspace')}
                />
                <ScopePill
                  label="All workspaces"
                  enabled={globalEnabled}
                  busy={busyModuleId === mod.id}
                  onRevoke={() => handleRevoke(mod.id, 'global')}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ScopePill: React.FC<{
  label: string;
  enabled: boolean;
  disabledReason?: string;
  busy: boolean;
  onRevoke: () => void;
}> = ({ label, enabled, disabledReason, busy, onRevoke }) => {
  if (disabledReason) {
    return (
      <span
        className="ext-backend-module-scope-pill px-2 py-1 text-xs rounded border border-[var(--nim-border)] text-[var(--nim-text-faint)] italic"
        title={disabledReason}
      >
        {label}: n/a
      </span>
    );
  }
  if (!enabled) {
    return (
      <span className="ext-backend-module-scope-pill px-2 py-1 text-xs rounded border border-[var(--nim-border)] text-[var(--nim-text-muted)]">
        {label}: not enabled
      </span>
    );
  }
  return (
    <span className="ext-backend-module-scope-pill inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-[var(--nim-success)] text-[var(--nim-success)]">
      <MaterialSymbol icon="check_circle" size={12} />
      {label}: enabled
      <button
        type="button"
        className="ml-1 text-[var(--nim-error)] hover:underline disabled:opacity-50"
        onClick={onRevoke}
        disabled={busy}
      >
        revoke
      </button>
    </span>
  );
};

function describeHostState(
  state: unknown
): { label: string; classes: string } | null {
  if (!state || typeof state !== 'object') return null;
  const status = (state as { status?: string }).status;
  if (!status) return null;
  switch (status) {
    case 'running':
      return { label: 'Running', classes: 'bg-[var(--nim-success)] text-[var(--nim-bg)]' };
    case 'starting':
      return { label: 'Starting', classes: 'bg-[var(--nim-warning)] text-[var(--nim-bg)]' };
    case 'awaiting-consent':
      return { label: 'Awaiting consent', classes: 'bg-[var(--nim-warning)] text-[var(--nim-bg)]' };
    case 'awaiting-trust':
      return { label: 'Workspace not trusted', classes: 'bg-[var(--nim-warning)] text-[var(--nim-bg)]' };
    case 'crashed':
      return { label: 'Crashed', classes: 'bg-[var(--nim-error)] text-[var(--nim-bg)]' };
    case 'denied':
      return { label: 'Denied', classes: 'bg-[var(--nim-error)] text-[var(--nim-bg)]' };
    case 'stopped':
      return { label: 'Stopped', classes: 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]' };
    default:
      return null;
  }
}
