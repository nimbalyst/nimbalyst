import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  FloatingPortal,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import { MaterialSymbol, getProviderIcon } from '@nimbalyst/runtime';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../common/AlphaBadge';
import { developerModeAtom } from '../../store/atoms/appSettings';
import {
  getSettingsRoutesForScope,
  type SettingsCategory,
  type SettingsRoute,
  type SettingsScope,
} from './settingsRoutes';

export type { SettingsCategory, SettingsScope } from './settingsRoutes';

interface SettingsSidebarProps {
  selectedCategory: SettingsCategory | string;
  onSelectCategory: (category: SettingsCategory | string) => void;
  providerStatus?: Record<string, { enabled: boolean; testStatus?: string }>;
  scope?: SettingsScope;
  orgChoices?: { orgId: string; name: string }[];
  selectedOrgId?: string | null;
  onSelectOrg?: (orgId: string) => void;
  pendingInviteCount?: number;
  onNewOrganization?: () => void;
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
  'Agent Providers': 'Agents can use tools and project files for multi-step work.',
  'Chat Providers': 'Chat providers make direct model calls for focused conversations.',
};

function routeIcon(route: SettingsRoute): React.ReactNode {
  if (['claude-code', 'claude', 'openai', 'openai-codex', 'minimax', 'opencode', 'copilot-cli', 'lmstudio'].includes(route.id)) {
    const providerId = route.id === 'openai-codex' ? 'openai' : route.id;
    return getProviderIcon(providerId, { size: 16 });
  }
  return <MaterialSymbol icon={route.icon} size={16} />;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  selectedCategory,
  onSelectCategory,
  providerStatus = {},
  scope = 'application',
  orgChoices = [],
  selectedOrgId = null,
  onSelectOrg,
  pendingInviteCount = 0,
  onNewOrganization,
}) => {
  const developerMode = useAtomValue(developerModeAtom);
  const [extAgentProviders, setExtAgentProviders] = useState<
    Array<{ id: string; name: string; icon?: string; status: string }>
  >([]);
  const [tooltipText, setTooltipText] = useState<string | null>(null);
  const { refs, floatingStyles } = useFloating({
    open: tooltipText !== null,
    placement: 'right',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  useEffect(() => {
    let cancelled = false;
    const invoke = window.electronAPI?.invoke;
    if (!invoke) return;
    invoke('agent-providers:list')
      .then((res: { success?: boolean; data?: Array<{ id: string; name: string; icon?: string; status: string }> }) => {
        if (!cancelled && res?.success && Array.isArray(res.data)) setExtAgentProviders(res.data);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const groups = useMemo(() => {
    const grouped = new Map<string, Array<SettingsRoute | { id: string; label: string; icon?: string; status: string }>>();
    for (const route of getSettingsRoutesForScope(scope, { developerMode })) {
      const entries = grouped.get(route.group) ?? [];
      entries.push(route);
      grouped.set(route.group, entries);
    }
    if (scope === 'application' && extAgentProviders.length > 0) {
      const entries = grouped.get('Agent Providers') ?? [];
      entries.push(...extAgentProviders.map((provider) => ({ ...provider, label: provider.name })));
      grouped.set('Agent Providers', entries);
    }
    return [...grouped.entries()];
  }, [developerMode, extAgentProviders, scope]);

  return (
    <aside
      className="settings-sidebar w-[240px] shrink-0 border-r border-[var(--nim-border)] bg-[var(--nim-bg)] overflow-y-auto"
      data-testid="settings-sidebar"
      data-component="SettingsSidebar"
    >
      <div className="settings-sidebar-content p-3">
        {scope === 'organization' && (
          <div className="settings-sidebar-org-picker mb-4" data-testid="settings-org-picker">
            <label className="block px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-muted)]">
              Organization
            </label>
            {orgChoices.length > 0 ? (
              <select
                value={selectedOrgId ?? ''}
                onChange={(event) => onSelectOrg?.(event.target.value)}
                className="settings-org-select w-full text-[13px] bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded-md px-2 py-1.5 text-[var(--nim-text)] cursor-pointer"
                data-testid="settings-org-select"
              >
                {orgChoices.map((organization) => (
                  <option key={organization.orgId} value={organization.orgId}>{organization.name}</option>
                ))}
              </select>
            ) : (
              <p className="m-0 px-2 text-xs text-[var(--nim-text-muted)]">No active organizations</p>
            )}
            <div className="mt-2 flex flex-col gap-1">
              {pendingInviteCount > 0 && (
                <button
                  type="button"
                  className="settings-pending-invites-button rounded px-2 py-1.5 text-left text-xs text-[var(--nim-link)] hover:bg-[var(--nim-bg-hover)]"
                  data-testid="settings-pending-invites-button"
                  onClick={() => onSelectCategory('organization-members')}
                >
                  {pendingInviteCount} pending invitation{pendingInviteCount === 1 ? '' : 's'}
                </button>
              )}
              <button
                type="button"
                className="settings-new-organization-button rounded px-2 py-1.5 text-left text-xs text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                data-testid="settings-new-organization-button"
                onClick={onNewOrganization}
              >
                New organization
              </button>
            </div>
          </div>
        )}

        {groups.map(([group, routes]) => (
          <section key={group} className="settings-sidebar-group mb-4" data-testid={`settings-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
            <div className="settings-sidebar-group-title flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--nim-text-muted)]">
              {group}
              {GROUP_DESCRIPTIONS[group] && (
                <button
                  type="button"
                  className="settings-sidebar-group-info inline-flex border-0 bg-transparent p-0 text-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)]"
                  aria-label={`About ${group}`}
                  onMouseEnter={(event) => {
                    refs.setReference(event.currentTarget);
                    setTooltipText(GROUP_DESCRIPTIONS[group]);
                  }}
                  onMouseLeave={() => setTooltipText(null)}
                  onFocus={(event) => {
                    refs.setReference(event.currentTarget);
                    setTooltipText(GROUP_DESCRIPTIONS[group]);
                  }}
                  onBlur={() => setTooltipText(null)}
                >
                  <MaterialSymbol icon="info" size={14} />
                </button>
              )}
            </div>
            {routes.map((route) => {
              const isRegistered = 'scope' in route;
              const id = route.id;
              const providerState = providerStatus[id];
              const status = !isRegistered
                ? route.status
                : providerState?.enabled ? providerState.testStatus : undefined;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`settings-route-${id}`}
                  className={`settings-sidebar-item w-full flex items-center gap-2 px-2 py-1.5 rounded text-left cursor-pointer text-sm transition-colors ${
                    selectedCategory === id
                      ? 'bg-[var(--nim-bg-selected)] text-[var(--nim-text)]'
                      : 'bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
                  }`}
                  onClick={() => onSelectCategory(id)}
                >
                  <span className="settings-sidebar-item-icon flex items-center justify-center w-5 h-5 shrink-0 text-[var(--nim-text-muted)]">
                    {isRegistered
                      ? routeIcon(route)
                      : route.icon ? <MaterialSymbol icon={route.icon} size={16} /> : getProviderIcon(id, { size: 16 })}
                  </span>
                  <span className="settings-sidebar-item-name flex-1 truncate">{route.label}</span>
                  {isRegistered && route.isAlpha && <AlphaBadge size="xs" tooltip={SETTINGS_ALPHA_TOOLTIP} />}
                  {(status === 'success' || status === 'active' || status === 'error' || status === 'denied') && (
                    <span className={`settings-sidebar-item-status h-2 w-2 rounded-full ${status === 'success' || status === 'active' ? 'bg-[var(--nim-success)]' : 'bg-[var(--nim-error)]'}`} />
                  )}
                </button>
              );
            })}
          </section>
        ))}
      </div>

      {tooltipText && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            role="tooltip"
            className="settings-sidebar-tooltip z-[10000] max-w-[280px] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-3 py-2 text-sm text-[var(--nim-text)] shadow-lg"
          >
            {tooltipText}
          </div>
        </FloatingPortal>
      )}
    </aside>
  );
};
