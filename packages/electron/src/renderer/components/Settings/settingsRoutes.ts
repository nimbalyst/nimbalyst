export type SettingsScope = 'application' | 'personal' | 'organization' | 'project';

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
  | 'minimax'
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

export type PersonalSettingsCategory =
  | 'personal-accounts'
  | 'personal-mobile'
  | 'personal-devices'
  | 'personal-shared-links';

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
  | PersonalSettingsCategory
  | OrganizationSettingsCategory
  | ProjectSettingsCategory;

export type LegacySettingsCategory =
  | 'sync'
  | 'shared-links'
  | 'team'
  | 'org'
  | 'tracker-config'
  | 'agent-permissions'
  | 'github'
  | 'installed';

/** Compatibility category accepted at old entry points during the route migration. */
export type SettingsCategory = RegisteredSettingsCategory | LegacySettingsCategory;

export type SettingsDestination =
  | { scope: 'application'; category: ApplicationSettingsCategory }
  | { scope: 'personal'; category: PersonalSettingsCategory }
  | { scope: 'organization'; category: OrganizationSettingsCategory; orgId: string }
  | {
      scope: 'project';
      category: ProjectSettingsCategory;
      target:
        | { kind: 'workspace'; workspacePath: string }
        | { kind: 'organizationProject'; orgId: string; projectId: string };
    };

export interface SettingsAvailabilityContext {
  developerMode: boolean;
}

export interface SettingsRoute {
  id: RegisteredSettingsCategory;
  scope: SettingsScope;
  group: string;
  label: string;
  icon: string;
  isAlpha?: boolean;
  isAvailable?: (context: SettingsAvailabilityContext) => boolean;
}

const developerOnly = ({ developerMode }: SettingsAvailabilityContext) => developerMode;

export const settingsRoutes: readonly SettingsRoute[] = [
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
  { id: 'claude', scope: 'application', group: 'Chat Providers', label: 'Claude Chat', icon: 'chat' },
  { id: 'openai', scope: 'application', group: 'Chat Providers', label: 'OpenAI', icon: 'chat' },
  { id: 'minimax', scope: 'application', group: 'Chat Providers', label: 'MiniMax', icon: 'bolt' },
  { id: 'lmstudio', scope: 'application', group: 'Chat Providers', label: 'LM Studio', icon: 'memory' },
  { id: 'marketplace', scope: 'application', group: 'Extensions', label: 'Marketplace', icon: 'storefront' },
  { id: 'installed-extensions', scope: 'application', group: 'Extensions', label: 'Installed', icon: 'extension' },
  { id: 'privileged-extensions', scope: 'application', group: 'Extensions', label: 'Privileged Capabilities', icon: 'shield_lock' },
  { id: 'claude-plugins', scope: 'application', group: 'Extensions', label: 'Claude Plugins', icon: 'widgets' },
  { id: 'mcp-servers', scope: 'application', group: 'Extensions', label: 'MCP Servers', icon: 'dns' },
  { id: 'tools-mcp', scope: 'application', group: 'Extensions', label: 'Tools & Token Cost', icon: 'data_usage' },

  { id: 'personal-accounts', scope: 'personal', group: 'Personal', label: 'Accounts', icon: 'account_circle' },
  { id: 'personal-mobile', scope: 'personal', group: 'Personal', label: 'Mobile App', icon: 'phone_iphone' },
  { id: 'personal-devices', scope: 'personal', group: 'Personal', label: 'Devices', icon: 'devices' },
  { id: 'personal-shared-links', scope: 'personal', group: 'Personal', label: 'Shared Links', icon: 'link' },

  { id: 'organization-members', scope: 'organization', group: 'Organization', label: 'Members & Roles', icon: 'groups' },
  { id: 'organization-projects', scope: 'organization', group: 'Organization', label: 'Projects', icon: 'folder_shared' },
  { id: 'organization-security', scope: 'organization', group: 'Organization', label: 'Security', icon: 'verified_user' },
  { id: 'organization-billing', scope: 'organization', group: 'Organization', label: 'Billing', icon: 'credit_card' },
  { id: 'organization-danger', scope: 'organization', group: 'Organization', label: 'Danger Zone', icon: 'warning' },

  { id: 'project-sharing', scope: 'project', group: 'Project', label: 'Sharing', icon: 'group' },
  { id: 'project-agent-permissions', scope: 'project', group: 'Project', label: 'Agent Permissions', icon: 'shield' },
  { id: 'project-trackers', scope: 'project', group: 'Project', label: 'Trackers', icon: 'assignment' },
  { id: 'project-ai-providers', scope: 'project', group: 'Project', label: 'AI Providers', icon: 'smart_toy' },
  { id: 'project-mcp-servers', scope: 'project', group: 'Project', label: 'MCP Servers', icon: 'dns' },
  { id: 'project-github', scope: 'project', group: 'Project', label: 'GitHub', icon: 'merge', isAvailable: developerOnly },
  { id: 'project-extensions', scope: 'project', group: 'Project', label: 'Extensions', icon: 'extension' },
] as const;

const defaults: Record<SettingsScope, RegisteredSettingsCategory> = {
  application: 'notifications',
  personal: 'personal-accounts',
  organization: 'organization-members',
  project: 'project-sharing',
};

export function getDefaultSettingsCategory(scope: SettingsScope): RegisteredSettingsCategory {
  return defaults[scope];
}

export function getSettingsRoutesForScope(
  scope: SettingsScope,
  context: SettingsAvailabilityContext,
): SettingsRoute[] {
  return settingsRoutes.filter((route) =>
    route.scope === scope && (route.isAvailable?.(context) ?? true));
}

export function isSettingsCategory(value: string): value is RegisteredSettingsCategory {
  return settingsRoutes.some((route) => route.id === value);
}

export function validateSettingsDestination(destination: SettingsDestination): boolean {
  const route = settingsRoutes.find((candidate) => candidate.id === destination.category);
  if (!route || route.scope !== destination.scope) return false;
  if (destination.scope === 'organization') return destination.orgId.trim().length > 0;
  if (destination.scope === 'project') {
    return destination.target.kind === 'workspace'
      ? destination.target.workspacePath.trim().length > 0
      : destination.target.orgId.trim().length > 0 && destination.target.projectId.trim().length > 0;
  }
  return true;
}

export type LegacySettingsScope = 'user' | 'application' | 'personal' | 'organization' | 'project';

export interface LegacySettingsLink {
  category?: string;
  scope?: LegacySettingsScope;
  orgId?: string;
  projectId?: string;
  workspacePath?: string;
}

export function normalizeSettingsDestination(link: LegacySettingsLink): SettingsDestination | null {
  const scope = link.scope === 'user' || !link.scope ? 'application' : link.scope;
  const legacyCategory = link.category;

  if (legacyCategory === 'sync') return { scope: 'personal', category: 'personal-mobile' };
  if (legacyCategory === 'shared-links') return { scope: 'personal', category: 'personal-shared-links' };
  if (scope === 'organization') {
    if (!link.orgId) return null;
    const category: OrganizationSettingsCategory = legacyCategory === 'team'
      ? 'organization-security'
      : legacyCategory === 'organization-projects'
        ? 'organization-projects'
        : 'organization-members';
    return { scope, category, orgId: link.orgId };
  }
  if (scope === 'project') {
    const target = link.projectId && link.orgId
      ? { kind: 'organizationProject' as const, orgId: link.orgId, projectId: link.projectId }
      : link.workspacePath
        ? { kind: 'workspace' as const, workspacePath: link.workspacePath }
        : null;
    if (!target) return null;
    const category: ProjectSettingsCategory = legacyCategory === 'tracker-config'
      ? 'project-trackers'
      : legacyCategory === 'agent-permissions'
        ? 'project-agent-permissions'
        : legacyCategory === 'mcp-servers'
          ? 'project-mcp-servers'
          : legacyCategory === 'github'
            ? 'project-github'
            : 'project-sharing';
    return { scope, category, target };
  }
  if (scope === 'personal') {
    const category = isSettingsCategory(legacyCategory ?? '') &&
      settingsRoutes.some((route) => route.id === legacyCategory && route.scope === 'personal')
      ? legacyCategory as PersonalSettingsCategory
      : 'personal-accounts';
    return { scope, category };
  }
  const category = isSettingsCategory(legacyCategory ?? '') &&
    settingsRoutes.some((route) => route.id === legacyCategory && route.scope === 'application')
    ? legacyCategory as ApplicationSettingsCategory
    : getDefaultSettingsCategory('application') as ApplicationSettingsCategory;
  return { scope: 'application', category };
}
