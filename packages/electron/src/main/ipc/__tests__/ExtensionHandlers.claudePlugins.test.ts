// @vitest-environment node
/**
 * #1465: Nimbalyst must not re-inject the plugins the user installed through
 * Claude's own `/plugin` command. Claude loads those natively (with their
 * marketplace identity and settings); handing them back as SDK `plugins` /
 * `--plugin-dir` entries created an unconfigured `@inline` twin of each.
 *
 * The two loaders here split by provenance:
 *   - injection  (`getExtensionClaudePluginPaths`, `getClaudePluginPaths`):
 *     enabled Nimbalyst extension plugins only.
 *   - discovery  (`getDiscoverableClaudePluginPaths`): the above plus the user's
 *     installed_plugins.json registry, so the slash-command picker still mirrors
 *     what the launched Claude will have loaded.
 *
 * Real directories and a real installed_plugins.json drive every case — nothing
 * about the filtering itself is mocked.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugins-config-'));

vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir', () => ({
  resolveClaudeConfigDir: () => claudeConfigDir,
}));

import {
  getClaudePluginPaths,
  getDiscoverableClaudePluginPaths,
  getExtensionClaudePluginPaths,
  getUserExtensionsDirectory,
} from '../ExtensionHandlers';
import { setClaudePluginEnabled, setExtensionEnabled } from '../../utils/store';

/** Write a minimal extension bundle whose manifest contributes a Claude plugin. */
function writeExtensionWithClaudePlugin(extensionsDir: string, extensionId: string): string {
  const extensionPath = path.join(extensionsDir, extensionId);
  const pluginPath = path.join(extensionPath, 'claude-plugin');
  fs.mkdirSync(path.join(pluginPath, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(extensionPath, 'manifest.json'),
    JSON.stringify({
      id: extensionId,
      name: extensionId,
      version: '0.1.0',
      main: 'dist/index.mjs',
      apiVersion: '1.0.0',
      contributions: { claudePlugin: { path: 'claude-plugin' } },
    }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(pluginPath, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: extensionId, version: '0.1.0', author: { name: 'Nimbalyst' } }),
    'utf-8',
  );
  return pluginPath;
}

/** Write a plugin directory of the shape `/plugin` installs into ~/.claude/plugins. */
function writeMarketplacePlugin(root: string, name: string): string {
  const pluginPath = path.join(root, name);
  fs.mkdirSync(path.join(pluginPath, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginPath, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', author: { name: 'Someone Else' } }),
    'utf-8',
  );
  return pluginPath;
}

describe('Claude plugin path provenance (#1465)', () => {
  const marketplaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugins-market-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugins-workspace-'));
  const otherWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugins-other-'));

  let enabledExtensionPlugin: string;
  let disabledExtensionPlugin: string;
  let pluginDisabledExtensionPlugin: string;
  let userScopedMarketplacePlugin: string;
  let projectScopedMarketplacePlugin: string;
  let foreignProjectMarketplacePlugin: string;
  let uninstalledMarketplacePlugin: string;
  const createdExtensionDirs: string[] = [];

  beforeAll(async () => {
    const extensionsDir = await getUserExtensionsDirectory();

    enabledExtensionPlugin = writeExtensionWithClaudePlugin(extensionsDir, 'nim-enabled');
    disabledExtensionPlugin = writeExtensionWithClaudePlugin(extensionsDir, 'nim-disabled');
    pluginDisabledExtensionPlugin = writeExtensionWithClaudePlugin(extensionsDir, 'nim-plugin-off');
    createdExtensionDirs.push(
      path.join(extensionsDir, 'nim-enabled'),
      path.join(extensionsDir, 'nim-disabled'),
      path.join(extensionsDir, 'nim-plugin-off'),
    );

    setExtensionEnabled('nim-enabled', true);
    setExtensionEnabled('nim-disabled', false);
    setExtensionEnabled('nim-plugin-off', true);
    setClaudePluginEnabled('nim-plugin-off', false);

    userScopedMarketplacePlugin = writeMarketplacePlugin(marketplaceRoot, 'market-user');
    projectScopedMarketplacePlugin = writeMarketplacePlugin(marketplaceRoot, 'market-project');
    foreignProjectMarketplacePlugin = writeMarketplacePlugin(marketplaceRoot, 'market-foreign');
    // Registered but no longer on disk — the registry outlives an uninstall.
    uninstalledMarketplacePlugin = path.join(marketplaceRoot, 'market-uninstalled');

    const installedAt = '2026-09-01T00:00:00.000Z';
    fs.mkdirSync(path.join(claudeConfigDir, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(claudeConfigDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'market-user@store': [
            { scope: 'user', installPath: userScopedMarketplacePlugin, version: '1.0.0', installedAt, lastUpdated: installedAt },
          ],
          'market-project@store': [
            { scope: 'project', projectPath: workspacePath, installPath: projectScopedMarketplacePlugin, version: '1.0.0', installedAt, lastUpdated: installedAt },
          ],
          'market-foreign@store': [
            { scope: 'project', projectPath: otherWorkspacePath, installPath: foreignProjectMarketplacePlugin, version: '1.0.0', installedAt, lastUpdated: installedAt },
          ],
          'market-uninstalled@store': [
            { scope: 'user', installPath: uninstalledMarketplacePlugin, version: '1.0.0', installedAt, lastUpdated: installedAt },
          ],
        },
      }),
      'utf-8',
    );
  });

  afterAll(() => {
    for (const dir of createdExtensionDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
    fs.rmSync(marketplaceRoot, { recursive: true, force: true });
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(otherWorkspacePath, { recursive: true, force: true });
  });

  it('injects enabled extension plugins only — never the user\'s installed_plugins.json entries', async () => {
    const injected = (await getExtensionClaudePluginPaths()).map(plugin => plugin.path);

    expect(injected).toContain(enabledExtensionPlugin);
    expect(injected).not.toContain(disabledExtensionPlugin);
    expect(injected).not.toContain(pluginDisabledExtensionPlugin);
    expect(injected).not.toContain(userScopedMarketplacePlugin);
    expect(injected).not.toContain(projectScopedMarketplacePlugin);
  });

  it('keeps marketplace plugins out of the no-workspace SDK launch input', async () => {
    const injected = (await getClaudePluginPaths()).map(plugin => plugin.path);
    const withWorkspace = (await getClaudePluginPaths(workspacePath)).map(plugin => plugin.path);

    expect(injected).toContain(enabledExtensionPlugin);
    expect(injected).not.toContain(userScopedMarketplacePlugin);
    // A workspace argument must not smuggle project-scoped registry entries in.
    expect(withWorkspace).toEqual(injected);
  });

  it('still discovers marketplace plugins for the picker, scoped by config dir and project path', async () => {
    const discovered = (await getDiscoverableClaudePluginPaths(workspacePath)).map(plugin => plugin.path);

    expect(discovered).toContain(enabledExtensionPlugin);
    expect(discovered).toContain(userScopedMarketplacePlugin);
    expect(discovered).toContain(projectScopedMarketplacePlugin);
    // Registered against a different project, and registered but uninstalled.
    expect(discovered).not.toContain(foreignProjectMarketplacePlugin);
    expect(discovered).not.toContain(uninstalledMarketplacePlugin);
    // Extension-level filtering still applies on the discovery side.
    expect(discovered).not.toContain(disabledExtensionPlugin);
  });

  it('drops project-scoped marketplace plugins from discovery when no workspace is given', async () => {
    const discovered = (await getDiscoverableClaudePluginPaths()).map(plugin => plugin.path);

    expect(discovered).toContain(userScopedMarketplacePlugin);
    expect(discovered).not.toContain(projectScopedMarketplacePlugin);
  });
});
