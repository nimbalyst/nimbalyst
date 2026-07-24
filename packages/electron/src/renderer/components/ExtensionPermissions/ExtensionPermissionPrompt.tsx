/**
 * Extension Permission Prompt
 *
 * Modal mounted globally that reads the prompt queue from
 * `extensionPermissionPromptQueueAtom` (populated by the central listener
 * in `extensionPermissionListeners.ts`), shows the head of the queue, and
 * forwards the user's decision back via `extPermissions.resolvePrompt`.
 *
 * The actual grant write happens in the renderer's grant-module IPC just
 * before resolving, so main sees the freshly-written grant when it
 * re-checks. Multiple pending prompts queue and render one at a time.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { extensionPermissionPromptQueueAtom } from '../../store/atoms/extensionPermissions';

type RiskTier = 'low' | 'elevated' | 'high';

interface PermissionDescriptor {
  id: string;
  label: string;
  description: string;
  risk: RiskTier;
}

const RISK_ORDER: RiskTier[] = ['high', 'elevated', 'low'];

const RISK_LABEL: Record<RiskTier, string> = {
  high: 'High risk',
  elevated: 'Elevated',
  low: 'Low risk',
};

const RISK_TEXT_CLASS: Record<RiskTier, string> = {
  high: 'text-[var(--nim-error)]',
  elevated: 'text-[var(--nim-warning)]',
  low: 'text-[var(--nim-text-muted)]',
};

const RISK_ICON: Record<RiskTier, string> = {
  high: 'warning',
  elevated: 'shield',
  low: 'check_circle',
};

export const ExtensionPermissionPrompt: React.FC = () => {
  const [queue, setQueue] = useAtom(extensionPermissionPromptQueueAtom);
  const [descriptors, setDescriptors] = useState<PermissionDescriptor[] | null>(null);

  // The preload exposes the permissions API only after a full Electron
  // restart - HMR doesn't reload preload scripts. Guard so this component
  // is a no-op (rather than crashing the renderer) when running against a
  // stale preload until the user restarts.
  const api = window.electronAPI?.extensions?.permissions;

  // Load descriptor catalog once.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api
      .listDescriptors()
      .then((d) => {
        if (!cancelled) setDescriptors(d);
      })
      .catch(() => {
        if (!cancelled) setDescriptors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const current = queue[0];

  const descriptorById = useMemo(() => {
    const map = new Map<string, PermissionDescriptor>();
    for (const d of descriptors ?? []) map.set(d.id, d);
    return map;
  }, [descriptors]);

  const groupedPermissions = useMemo(() => {
    if (!current) return null;
    const groups: Record<RiskTier, PermissionDescriptor[]> = { high: [], elevated: [], low: [] };
    const addedSet =
      current.reason.kind === 're-prompt-update'
        ? new Set(current.reason.addedPermissions)
        : new Set<string>();
    for (const id of current.declaredPermissions) {
      const d = descriptorById.get(id);
      if (d) groups[d.risk].push(d);
    }
    return { groups, addedSet };
  }, [current, descriptorById]);

  const respond = useCallback(
    (decision: 'enable-workspace' | 'enable-global' | 'not-now') => {
      if (!current || !api) return;
      // For "enable" decisions, write the grant first then resolve so main
      // sees the freshly-written grant when it re-checks.
      const finish = () => {
        api.resolvePrompt(current.id, { decision });
        setQueue((q) => q.filter((r) => r.id !== current.id));
      };
      if (decision === 'not-now') {
        finish();
        return;
      }
      const scope = decision === 'enable-global' ? 'global' : 'workspace';
      void api
        .grantModule({
          extensionId: current.extensionId,
          moduleId: current.moduleId,
          permissions: current.declaredPermissions,
          scope,
          workspacePath: scope === 'workspace' ? current.workspacePath : undefined,
        })
        .then(finish)
        .catch((err: unknown) => {
          console.error('[ExtensionPermissionPrompt] grant failed:', err);
          finish();
        });
    },
    [current, api]
  );

  if (!current || !groupedPermissions) return null;

  const title =
    current.reason.kind === 'first-use'
      ? `Enable ${current.extensionName}?`
      : `${current.extensionName} needs new permissions`;

  return (
    <div className="ext-permission-prompt-overlay nim-overlay" onClick={() => respond('not-now')}>
      <div
        className="ext-permission-prompt nim-modal min-w-[480px] max-w-[640px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="ext-permission-prompt-title m-0 mb-2 text-lg font-semibold text-nim">
          {title}
        </h2>
        <p className="ext-permission-prompt-purpose m-0 mb-4 text-sm text-nim leading-relaxed">
          {current.purpose}
        </p>
        {current.reason.kind === 're-prompt-update' && (
          <div className="ext-permission-prompt-update-banner mb-4 flex items-start gap-2 rounded border border-[var(--nim-warning)] bg-[rgba(245,158,11,0.08)] p-3 text-xs text-nim">
            <MaterialSymbol icon="upgrade" size={16} />
            <span>
              This extension updated and now requires {current.reason.addedPermissions.length} additional{' '}
              {current.reason.addedPermissions.length === 1 ? 'permission' : 'permissions'}, marked NEW below.
            </span>
          </div>
        )}

        {/* Backend modules always run native Node code on the user's machine.
            That capability is not a granular catalog permission -- once the
            module starts, it can use `require('child_process')`, `fs`, `net`
            and so on directly. The granular checkboxes below are only for
            host-brokered services (DB, secrets, MCP). Make this trade-off
            explicit so the user is informed before granting. */}
        <div className="ext-permission-prompt-native-banner mb-4 flex items-start gap-2 rounded border border-[var(--nim-error)] bg-[rgba(239,68,68,0.08)] p-3 text-xs text-nim">
          <MaterialSymbol icon="warning" size={16} />
          <div className="flex-1 leading-relaxed">
            <div className="font-semibold mb-1">This extension will run native code on your computer.</div>
            <div className="text-nim-muted">
              Enabling this module lets it spawn processes, open network connections, and read or write files
              with the same access your user account has. Only enable extensions from sources you trust.
            </div>
          </div>
        </div>

        <div className="ext-permission-prompt-groups mb-5 flex flex-col gap-4">
          {RISK_ORDER.map((tier) => {
            const items = groupedPermissions.groups[tier];
            if (items.length === 0) return null;
            return (
              <div key={tier} className="ext-permission-prompt-group">
                <div
                  className={`ext-permission-prompt-group-title flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider mb-2 ${RISK_TEXT_CLASS[tier]}`}
                >
                  <MaterialSymbol icon={RISK_ICON[tier]} size={14} />
                  {RISK_LABEL[tier]}
                </div>
                <ul className="ext-permission-prompt-list m-0 p-0 list-none flex flex-col gap-2">
                  {items.map((d) => {
                    const isNew = groupedPermissions.addedSet.has(d.id);
                    return (
                      <li
                        key={d.id}
                        className="ext-permission-prompt-item flex items-start gap-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] p-3"
                      >
                        <div className="flex-1">
                          <div className="ext-permission-prompt-item-label flex items-center gap-2 text-sm font-medium text-nim">
                            {d.label}
                            {isNew && (
                              <span className="ext-permission-prompt-item-new text-[10px] font-semibold uppercase tracking-wider rounded bg-[var(--nim-warning)] px-1.5 py-0.5 text-[var(--nim-bg)]">
                                New
                              </span>
                            )}
                          </div>
                          <div className="ext-permission-prompt-item-description mt-0.5 text-xs text-nim-muted leading-relaxed">
                            {d.description}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <p className="ext-permission-prompt-footnote m-0 mb-4 text-xs text-nim-muted leading-relaxed">
          You can revoke this at any time from Settings &rarr; Extensions.
        </p>

        {/* Consent to run native code is a per-module trust decision, not a
            per-workspace one -- so there is a single "Enable" that grants
            globally. Scoping this to one workspace would only mean the user
            gets re-prompted the next time they open a different project, which
            is noise, not safety. */}
        <div className="ext-permission-prompt-buttons flex gap-2 justify-end flex-wrap">
          <button
            className="ext-permission-prompt-button-decline nim-btn-secondary"
            onClick={() => respond('not-now')}
          >
            Not now
          </button>
          <button
            className="ext-permission-prompt-button-enable nim-btn-primary"
            onClick={() => respond('enable-global')}
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
};
