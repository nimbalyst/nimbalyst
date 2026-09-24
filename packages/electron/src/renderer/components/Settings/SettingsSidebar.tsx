import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  FloatingPortal,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { getProviderIcon } from '@nimbalyst/runtime/ui/icons/ProviderIcons';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../common/AlphaBadge';
import { TEAM_BETA_TOOLTIP } from '../common/TeamBetaNotice';
import { developerModeAtom } from '../../store/atoms/appSettings';
import { teamsConfiguredAtom } from '../../store/atoms/settingsDomains';
import {
  getSettingsRoutesForScope,
  type SettingsCategory,
  type ExtensionSettingsRoute,
  type SettingsRoute,
  type SettingsScope,
} from './settingsRoutes';
import { searchSettings } from './settingsSearch';
import { SETTINGS_SEARCH_ENTRIES } from './settingsSearchIndex';

export type { SettingsCategory, SettingsScope } from './settingsRoutes';

interface SettingsSidebarProps {
  selectedCategory: SettingsCategory | string;
  onSelectCategory: (category: SettingsCategory | string) => void;
  /** Opens a page and jumps to one row on it, from a search result. */
  onSelectSetting?: (category: string, anchor: string) => void;
  providerStatus?: Record<string, { enabled: boolean; testStatus?: string }>;
  scope?: SettingsScope;
  showDirectChatProviders: boolean;
  extensionRoutes?: readonly ExtensionSettingsRoute[];
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
  'Agent Providers': 'Agents can use tools and project files for multi-step work.',
  'Chat Providers': 'Chat providers make direct model calls for focused conversations.',
};

function routeIcon(route: SettingsRoute): React.ReactNode {
  if (['claude-code', 'claude', 'openai', 'openai-codex', 'opencode', 'copilot-cli', 'grok-build', 'cursor-agent', 'antigravity-gemini-agent', 'lmstudio'].includes(route.id)) {
    const providerId = route.id === 'openai-codex' ? 'openai' : route.id;
    return getProviderIcon(providerId, { size: 16 });
  }
  return <MaterialSymbol icon={route.icon} size={16} />;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = ({
  selectedCategory,
  onSelectCategory,
  onSelectSetting,
  providerStatus = {},
  scope = 'application',
  showDirectChatProviders,
  extensionRoutes = [],
}) => {
  const developerMode = useAtomValue(developerModeAtom);
  const teamsConfigured = useAtomValue(teamsConfiguredAtom);
  const [extAgentProviders, setExtAgentProviders] = useState<
    Array<{ id: string; name: string; icon?: string; status: string }>
  >([]);
  const [tooltipText, setTooltipText] = useState<string | null>(null);
  const { refs, floatingStyles } = useFloating({
    open: tooltipText !== null,
    placement: 'right',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
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
    for (const route of getSettingsRoutesForScope(
      scope,
      { developerMode, showDirectChatProviders, teamsConfigured },
      extensionRoutes,
    )) {
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
  }, [developerMode, extAgentProviders, extensionRoutes, scope, showDirectChatProviders, teamsConfigured]);

  const [query, setQuery] = useState('');
  // Built from the same grouped list the sidebar shows, so search offers
  // exactly the pages (and those pages' settings) visible in this scope.
  const results = useMemo(() => {
    const pages = groups.flatMap(([, routes]) => routes.map((route) => ({ id: route.id, label: route.label })));
    return searchSettings(query, pages, SETTINGS_SEARCH_ENTRIES);
  }, [groups, query]);
  const isSearching = query.trim().length > 0;

  return (
    <aside
      className="settings-sidebar w-[240px] shrink-0 border-r border-[var(--nim-border)] bg-[var(--nim-bg)] overflow-y-auto"
      data-testid="settings-sidebar"
      data-component="SettingsSidebar"
    >
      <div className="settings-sidebar-search sticky top-0 z-10 bg-[var(--nim-bg)] px-3 pt-3 pb-2">
        <div className="relative flex items-center">
          <MaterialSymbol icon="search" size={16} className="pointer-events-none absolute left-2 text-[var(--nim-text-faint)]" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            spellCheck={false}
            data-testid="settings-search-input"
            className="w-full py-1.5 pl-7 pr-2 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none placeholder:text-[var(--nim-text-faint)] focus:border-[var(--nim-primary)]"
          />
        </div>
      </div>

      {isSearching ? (
        <div className="settings-search-results px-3 pb-3" data-testid="settings-search-results">
          {results.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-[var(--nim-text-muted)]">No settings match &ldquo;{query.trim()}&rdquo;</p>
          ) : (
            results.map((result) => (
              <button
                key={result.kind === 'page' ? `page:${result.category}` : `setting:${result.anchor}`}
                type="button"
                data-testid="settings-search-result"
                title={result.kind === 'setting' ? result.description : undefined}
                className="settings-search-result w-full flex items-start gap-2 px-2 py-1.5 rounded text-left cursor-pointer text-sm bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                onClick={() => {
                  if (result.kind === 'setting' && onSelectSetting) {
                    onSelectSetting(result.category, result.anchor);
                  } else {
                    onSelectCategory(result.category);
                  }
                  setQuery('');
                }}
              >
                <span className="flex items-center justify-center w-5 h-5 shrink-0 text-[var(--nim-text-muted)]">
                  <MaterialSymbol icon={result.kind === 'page' ? 'article' : 'tune'} size={16} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-[var(--nim-text)]">
                    {result.kind === 'page' ? result.label : result.name}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--nim-text-faint)]">
                    {result.kind === 'page' ? 'Page' : result.pageLabel}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="settings-sidebar-content px-3 pb-3">
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
                const isSettingsRoute = 'source' in route;
                const id = route.id;
                const providerState = providerStatus[id];
                const status = !isSettingsRoute
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
                      {isSettingsRoute
                        ? routeIcon(route)
                        : route.icon ? <MaterialSymbol icon={route.icon} size={16} /> : getProviderIcon(id, { size: 16 })}
                    </span>
                    <span className="settings-sidebar-item-name flex-1 truncate">{route.label}</span>
                    {isSettingsRoute && route.source === 'builtin' && route.isAlpha && (
                      <AlphaBadge
                        size="xs"
                        // Sharing is the org/Teams entry point, so it is labelled
                        // beta and gets the Teams-specific pricing disclosure.
                        stage={route.id === 'project-sharing' ? 'beta' : 'alpha'}
                        tooltip={route.id === 'project-sharing' ? TEAM_BETA_TOOLTIP : SETTINGS_ALPHA_TOOLTIP}
                      />
                    )}
                    {(status === 'success' || status === 'active' || status === 'error' || status === 'denied') && (
                      <span className={`settings-sidebar-item-status h-2 w-2 rounded-full ${status === 'success' || status === 'active' ? 'bg-[var(--nim-success)]' : 'bg-[var(--nim-error)]'}`} />
                    )}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}

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
