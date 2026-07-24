export type SettingsScope = 'application' | 'account' | 'project';

export type ApplicationSettingsCategory =
  | 'notifications'
  | 'themes'
  | 'voice-mode'
  | 'advanced'
  | 'database'
  | 'agent-features'
  | 'beta-features'
  | 'claude-code'
  | 'claude'
  | 'openai'
  | 'openai-codex'
  | 'opencode'
  | 'copilot-cli'
  | 'lmstudio'
  | 'marketplace'
  | 'installed-extensions'
  | 'privileged-extensions'
  | 'claude-plugins'
  | 'mcp-servers'
  | 'tools-mcp';

/**
 * Each account route renders exactly ONE panel. They used to all resolve to a
 * single stacked panel, which is why the screen opened with an "Account" title
 * immediately followed by an "Account & Sync" section header.
 */
export type AccountSettingsCategory =
  | 'account'
  | 'account-mobile'
  | 'account-devices'
  | 'account-shared-links';

/** Old personal routes remain accepted only so persisted links can migrate. */
export type PersonalSettingsCategory =
  | 'personal-accounts'
  | 'personal-mobile'
  | 'personal-devices'
  | 'personal-shared-links';

/** Organization administration moved to the in-app Team surface. */
export type OrganizationSettingsCategory =
  | 'organization-members'
  | 'organization-projects'
  | 'organization-security'
  | 'organization-billing'
  | 'organization-danger';

export type ProjectSettingsCategory =
  | 'project-sharing'
  | 'project-agent-permissions'
  | 'project-trackers'
  | 'project-ai-providers'
  | 'project-mcp-servers'
  | 'project-github'
  | 'project-extensions';

export type RegisteredSettingsCategory =
  | ApplicationSettingsCategory
  | AccountSettingsCategory
  | ProjectSettingsCategory;

/** Namespaced id for a first-class route contributed by an extension. */
export type ExtensionSettingsRouteId = `ext:${string}`;

export type LegacySettingsCategory =
  | PersonalSettingsCategory
  | OrganizationSettingsCategory
  | 'sync'
  | 'shared-links'
  | 'team'
  | 'org'
  | 'tracker-config'
  | 'agent-permissions'
  | 'github'
  | 'installed';

/** Compatibility category accepted at old entry points during the route migration. */
export type SettingsCategory =
  | RegisteredSettingsCategory
  | ExtensionSettingsRouteId
  | LegacySettingsCategory;

export type SettingsDestination =
  | { scope: 'application'; category: ApplicationSettingsCategory | ExtensionSettingsRouteId }
  | { scope: 'account'; category: AccountSettingsCategory }
  | {
      scope: 'project';
      category: ProjectSettingsCategory | ExtensionSettingsRouteId;
      target:
        | { kind: 'workspace'; workspacePath: string }
        | { kind: 'organizationProject'; orgId: string; projectId: string };
    };

export interface SettingsAvailabilityContext {
  developerMode: boolean;
  showDirectChatProviders: boolean;
}

export interface BuiltinSettingsRoute {
  source: 'builtin';
  id: RegisteredSettingsCategory;
  scope: SettingsScope;
  group: string;
  label: string;
  icon: string;
  isAlpha?: boolean;
  isAvailable?: (context: SettingsAvailabilityContext) => boolean;
}

export interface ExtensionSettingsRoute {
  source: 'extension';
  id: ExtensionSettingsRouteId;
  scope: 'application' | 'project';
  group: string;
  label: string;
  icon: string;
  extensionId: string;
  componentName: string;
  order: number;
}

export type SettingsRoute = BuiltinSettingsRoute | ExtensionSettingsRoute;

const developerOnly = ({ developerMode }: SettingsAvailabilityContext) => developerMode;
const directChatProvidersVisible = ({ showDirectChatProviders }: SettingsAvailabilityContext) =>
  showDirectChatProviders;

const builtinSettingsRouteDefinitions: readonly Omit<BuiltinSettingsRoute, 'source'>[] = [
  { id: 'notifications', scope: 'application', group: 'Application', label: 'Notifications', icon: 'notifications' },
  { id: 'themes', scope: 'application', group: 'Application', label: 'Themes', icon: 'palette' },
  { id: 'voice-mode', scope: 'application', group: 'Application', label: 'Voice Mode', icon: 'mic', isAlpha: true },
  { id: 'agent-features', scope: 'application', group: 'Application', label: 'Agent Features', icon: 'science', isAlpha: true },
  { id: 'advanced', scope: 'application', group: 'Application', label: 'Advanced', icon: 'settings' },
  { id: 'database', scope: 'application', group: 'Application', label: 'Database', icon: 'database', isAlpha: true, isAvailable: developerOnly },
  { id: 'beta-features', scope: 'application', group: 'Application', label: 'Beta Features', icon: 'biotech', isAvailable: () => false },
  { id: 'claude-code', scope: 'application', group: 'Agent Providers', label: 'Claude Agent', icon: 'smart_toy' },
  { id: 'openai-codex', scope: 'application', group: 'Agent Providers', label: 'OpenAI Codex', icon: 'smart_toy' },
  { id: 'opencode', scope: 'application', group: 'Agent Providers', label: 'OpenCode', icon: 'terminal', isAlpha: true },
  { id: 'copilot-cli', scope: 'application', group: 'Agent Providers', label: 'GitHub Copilot', icon: 'terminal', isAlpha: true },
  { id: 'claude', scope: 'application', group: 'Chat Providers', label: 'Claude Chat', icon: 'chat', isAvailable: directChatProvidersVisible },
  { id: 'openai', scope: 'application', group: 'Chat Providers', label: 'OpenAI', icon: 'chat', isAvailable: directChatProvidersVisible },
  { id: 'lmstudio', scope: 'application', group: 'Chat Providers', label: 'LM Studio', icon: 'memory', isAvailable: directChatProvidersVisible },
  { id: 'marketplace', scope: 'application', group: 'Extensions', label: 'Marketplace', icon: 'storefront' },
  { id: 'installed-extensions', scope: 'application', group: 'Extensions', label: 'Installed', icon: 'extension' },
  { id: 'privileged-extensions', scope: 'application', group: 'Extensions', label: 'Privileged Capabilities', icon: 'shield_lock' },
  { id: 'claude-plugins', scope: 'application', group: 'Extensions', label: 'Claude Plugins', icon: 'widgets' },
  { id: 'mcp-servers', scope: 'application', group: 'Extensions', label: 'MCP Servers', icon: 'dns' },
  { id: 'tools-mcp', scope: 'application', group: 'Extensions', label: 'Tools & Token Cost', icon: 'data_usage' },

  { id: 'account', scope: 'account', group: 'Account', label: 'Accounts', icon: 'account_circle' },
  { id: 'account-mobile', scope: 'account', group: 'Account', label: 'Mobile App', icon: 'smartphone' },
  { id: 'account-devices', scope: 'account', group: 'Account', label: 'Devices', icon: 'devices' },
  { id: 'account-shared-links', scope: 'account', group: 'Account', label: 'Shared Links', icon: 'link' },

  { id: 'project-sharing', scope: 'project', group: 'Project', label: 'Sharing', icon: 'group', isAlpha: true },
  { id: 'project-agent-permissions', scope: 'project', group: 'Project', label: 'Agent Permissions', icon: 'shield' },
  { id: 'project-trackers', scope: 'project', group: 'Project', label: 'Trackers', icon: 'assignment' },
  { id: 'project-ai-providers', scope: 'project', group: 'Project', label: 'AI Providers', icon: 'smart_toy' },
  { id: 'project-mcp-servers', scope: 'project', group: 'Project', label: 'MCP Servers', icon: 'dns' },
  { id: 'project-github', scope: 'project', group: 'Project', label: 'GitHub', icon: 'merge', isAvailable: developerOnly },
  { id: 'project-extensions', scope: 'project', group: 'Project', label: 'Extensions', icon: 'extension' },
] as const;

export const settingsRoutes: readonly BuiltinSettingsRoute[] = builtinSettingsRouteDefinitions.map(
  (route) => ({ ...route, source: 'builtin' }),
);

const defaults: Record<SettingsScope, RegisteredSettingsCategory> = {
  application: 'notifications',
  account: 'account',
  project: 'project-sharing',
};

export function getDefaultSettingsCategory(scope: SettingsScope): RegisteredSettingsCategory {
  return defaults[scope];
}

export function getSettingsRoutesForScope(
  scope: SettingsScope,
  context: SettingsAvailabilityContext,
  extensionRoutes: readonly ExtensionSettingsRoute[] = [],
): SettingsRoute[] {
  const builtins = settingsRoutes.filter((route) =>
    route.scope === scope && (route.isAvailable?.(context) ?? true));
  const extensions = extensionRoutes
    .filter((route) => route.scope === scope)
    .sort((a, b) =>
      a.group.localeCompare(b.group)
      || a.order - b.order
      || a.label.localeCompare(b.label)
      || a.id.localeCompare(b.id));
  return [...builtins, ...extensions];
}

export function isExtensionSettingsRouteId(value: string): value is ExtensionSettingsRouteId {
  return value.startsWith('ext:');
}

export function isSettingsCategory(
  value: string,
): value is RegisteredSettingsCategory | ExtensionSettingsRouteId {
  return isExtensionSettingsRouteId(value) || settingsRoutes.some((route) => route.id === value);
}

export function validateSettingsDestination(destination: SettingsDestination): boolean {
  if (isExtensionSettingsRouteId(destination.category)) {
    if (destination.scope === 'account') return false;
    if (destination.scope === 'application') return true;
    return destination.target.kind === 'workspace'
      ? destination.target.workspacePath.trim().length > 0
      : destination.target.orgId.trim().length > 0 && destination.target.projectId.trim().length > 0;
  }
  const route = settingsRoutes.find((candidate) => candidate.id === destination.category);
  if (!route || route.scope !== destination.scope) return false;
  if (destination.scope === 'project') {
    return destination.target.kind === 'workspace'
      ? destination.target.workspacePath.trim().length > 0
      : destination.target.orgId.trim().length > 0 && destination.target.projectId.trim().length > 0;
  }
  return true;
}

export type LegacySettingsScope =
  | 'user'
  | 'application'
  | 'account'
  | 'personal'
  | 'organization'
  | 'project';

export interface LegacySettingsLink {
  category?: string;
  scope?: LegacySettingsScope;
  orgId?: string;
  projectId?: string;
  workspacePath?: string;
}

export function normalizeSettingsDestination(link: LegacySettingsLink): SettingsDestination | null {
  const legacyCategory = link.category;
  const rawScope = link.scope ?? 'application';

  if (rawScope === 'organization') return null;
  if (
    rawScope === 'personal'
    || rawScope === 'account'
    || legacyCategory === 'sync'
    || legacyCategory === 'shared-links'
    || legacyCategory?.startsWith('personal-')
    || legacyCategory?.startsWith('account-')
  ) {
    // Old personal-* links land on the account route that now owns that section.
    const category: AccountSettingsCategory =
      // 'sync' is the tips' deep link to pairing / prevent-sleep, both of which
      // live in the Mobile App panel.
      legacyCategory === 'personal-mobile'
      || legacyCategory === 'account-mobile'
      || legacyCategory === 'sync'
        ? 'account-mobile'
        : legacyCategory === 'personal-devices' || legacyCategory === 'account-devices'
          ? 'account-devices'
          : legacyCategory === 'personal-shared-links'
            || legacyCategory === 'shared-links'
            || legacyCategory === 'account-shared-links'
            ? 'account-shared-links'
            : 'account';
    return { scope: 'account', category };
  }

  if (rawScope === 'project') {
    const target = link.projectId && link.orgId
      ? { kind: 'organizationProject' as const, orgId: link.orgId, projectId: link.projectId }
      : link.workspacePath
        ? { kind: 'workspace' as const, workspacePath: link.workspacePath }
        : null;
    if (!target) return null;
    if (legacyCategory && isExtensionSettingsRouteId(legacyCategory)) {
      return { scope: 'project', category: legacyCategory, target };
    }
    const category: ProjectSettingsCategory = legacyCategory === 'tracker-config'
      ? 'project-trackers'
      : legacyCategory === 'agent-permissions'
        ? 'project-agent-permissions'
        : legacyCategory === 'mcp-servers'
          ? 'project-mcp-servers'
          : legacyCategory === 'github'
            ? 'project-github'
            : 'project-sharing';
    return { scope: 'project', category, target };
  }

  if (legacyCategory && isExtensionSettingsRouteId(legacyCategory)) {
    return { scope: 'application', category: legacyCategory };
  }

  const category = isSettingsCategory(legacyCategory ?? '')
    && settingsRoutes.some((route) => route.id === legacyCategory && route.scope === 'application')
    ? legacyCategory as ApplicationSettingsCategory
    : getDefaultSettingsCategory('application') as ApplicationSettingsCategory;
  return { scope: 'application', category };
}
