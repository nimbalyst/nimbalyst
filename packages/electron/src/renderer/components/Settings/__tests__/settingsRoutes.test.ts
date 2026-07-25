import { describe, expect, it } from 'vitest';

import {
  getDefaultSettingsCategory,
  getSettingsRoutesForScope,
  isExtensionSettingsRouteId,
  normalizeSettingsDestination,
  type ExtensionSettingsRoute,
  validateSettingsDestination,
} from '../settingsRoutes';

const extensionRoutes: ExtensionSettingsRoute[] = [
  {
    source: 'extension',
    id: 'ext:com.example.memory:memory',
    extensionId: 'com.example.memory',
    scope: 'project',
    group: 'Extensions',
    label: 'Memory',
    icon: 'psychology',
    componentName: 'MemorySettings',
    order: 50,
  },
  {
    source: 'extension',
    id: 'ext:com.example.deploy:deploy',
    extensionId: 'com.example.deploy',
    scope: 'application',
    group: 'Extensions',
    label: 'Deploy',
    icon: 'cloud_upload',
    componentName: 'DeploySettings',
    order: 10,
  },
];

describe('settings route registry', () => {
  it('declares every route in exactly one scope', () => {
    const seen = new Map<string, string>();
    for (const scope of ['application', 'account', 'project'] as const) {
      for (const route of getSettingsRoutesForScope(scope, {
        developerMode: true,
        showDirectChatProviders: true,
      })) {
        expect(seen.has(route.id)).toBe(false);
        seen.set(route.id, scope);
        expect(route.scope).toBe(scope);
      }
    }
  });

  it('exposes exactly the three approved settings scopes with deterministic defaults', () => {
    expect(getDefaultSettingsCategory('application')).toBe('notifications');
    expect(getDefaultSettingsCategory('account')).toBe('account');
    expect(getDefaultSettingsCategory('project')).toBe('project-sharing');
  });

  it('keeps project-level MCP server configuration reachable', () => {
    const projectRoutes = getSettingsRoutesForScope('project', {
      developerMode: false,
      showDirectChatProviders: false,
    });

    expect(projectRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'project-mcp-servers',
        scope: 'project',
        label: 'MCP Servers',
      }),
    ]));
    expect(normalizeSettingsDestination({
      category: 'mcp-servers',
      scope: 'project',
      workspacePath: '/workspace',
    })).toEqual({
      scope: 'project',
      category: 'project-mcp-servers',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    });
  });

  it('hides direct chat providers until the visibility policy reveals the group', () => {
    const hiddenRoutes = getSettingsRoutesForScope('application', {
      developerMode: false,
      showDirectChatProviders: false,
    });
    const visibleRoutes = getSettingsRoutesForScope('application', {
      developerMode: false,
      showDirectChatProviders: true,
    });

    expect(hiddenRoutes.map((route) => route.id)).not.toEqual(
      expect.arrayContaining(['claude', 'openai', 'lmstudio']),
    );
    expect(visibleRoutes.map((route) => route.id)).toEqual(
      expect.arrayContaining(['claude', 'openai', 'lmstudio']),
    );
  });

  it('requires explicit project context', () => {
    expect(validateSettingsDestination({
      scope: 'project',
      category: 'project-sharing',
      target: { kind: 'organizationProject', orgId: 'org-1', projectId: '' },
    })).toBe(false);
    expect(validateSettingsDestination({
      scope: 'project',
      category: 'project-sharing',
      target: { kind: 'organizationProject', orgId: 'org-1', projectId: 'project-1' },
    })).toBe(true);
  });

  it('merges extension routes only into their declared scope', () => {
    const projectRoutes = getSettingsRoutesForScope(
      'project',
      { developerMode: false, showDirectChatProviders: false },
      extensionRoutes,
    );
    const applicationRoutes = getSettingsRoutesForScope(
      'application',
      { developerMode: false, showDirectChatProviders: false },
      extensionRoutes,
    );

    expect(projectRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ext:com.example.memory:memory', source: 'extension' }),
    ]));
    expect(projectRoutes.map((route) => route.id)).not.toContain('ext:com.example.deploy:deploy');
    expect(applicationRoutes.map((route) => route.id)).toContain('ext:com.example.deploy:deploy');
  });

  it('recognizes and validates namespaced extension deep links', () => {
    expect(isExtensionSettingsRouteId('ext:com.example.memory:memory')).toBe(true);
    expect(isExtensionSettingsRouteId('project-sharing')).toBe(false);
    expect(validateSettingsDestination({
      scope: 'project',
      category: 'ext:com.example.memory:memory',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    })).toBe(true);
    expect(validateSettingsDestination({
      scope: 'project',
      category: 'ext:com.example.memory:memory',
      target: { kind: 'workspace', workspacePath: '' },
    })).toBe(false);
    expect(normalizeSettingsDestination({
      category: 'ext:com.example.memory:memory',
      scope: 'project',
      workspacePath: '/workspace',
    })).toEqual({
      scope: 'project',
      category: 'ext:com.example.memory:memory',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    });
  });

  it('translates legacy deep links without crossing identity lanes', () => {
    // 'sync' is the mobile tips' deep link (pairing / prevent-sleep), so it
    // resolves to the Mobile App panel rather than the accounts list.
    expect(normalizeSettingsDestination({ category: 'sync', scope: 'user' })).toEqual({
      scope: 'account',
      category: 'account-mobile',
    });
    expect(normalizeSettingsDestination({ category: 'org', scope: 'organization', orgId: 'org-1' })).toBeNull();
    expect(normalizeSettingsDestination({
      category: 'team',
      scope: 'project',
      workspacePath: '/workspace',
    })).toEqual({
      scope: 'project',
      category: 'project-sharing',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    });
    // The legacy 'github' project link must resolve to the GitHub page, not
    // fall through to Sharing (settings review finding).
    expect(normalizeSettingsDestination({
      category: 'github',
      scope: 'project',
      workspacePath: '/workspace',
    })).toEqual({
      scope: 'project',
      category: 'project-github',
      target: { kind: 'workspace', workspacePath: '/workspace' },
    });
  });
});
