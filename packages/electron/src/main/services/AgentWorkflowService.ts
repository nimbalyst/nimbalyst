import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { homedir } from 'os';
import * as path from 'path';
import { parseCommandFile, parseSkillFile, type SlashCommand, validateCommand } from './CommandFileParser';
import { getAllExtensionDirectories, getNativeClaudePluginPaths } from '../ipc/ExtensionHandlers';
import {
  getAgentWorkflowExportSettings,
  getAgentWorkflowSourceSettings,
  getAgentWorkflowsEnabled,
  getExtensionEnabled,
  getReleaseChannel,
  type ReleaseChannel,
} from '../utils/store';
import { usesCodexStyleAgentWorkflows } from '../../shared/agentWorkflowProviders';

export type AgentWorkflowKind = 'command' | 'skill';
export type AgentWorkflowInvocation = 'explicit' | 'implicit' | 'both';
export type AgentWorkflowSourceType =
  | 'workspace-claude-command'
  | 'workspace-claude-skill'
  | 'extension-workflow'
  | 'legacy-claude-plugin'
  | 'provider-native';

export interface WorkflowDiagnostic {
  code: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface AgentWorkflowDescriptor {
  id: string;
  name: string;
  kind: AgentWorkflowKind;
  title?: string;
  description?: string;
  invocation: AgentWorkflowInvocation;
  sourceType: AgentWorkflowSourceType;
  sourceId: string;
  sourcePath?: string;
  argumentHint?: string;
  allowedTools?: string[];
  body?: string;
  providerTargets: Array<'claude' | 'codex' | 'ui'>;
  diagnostics?: WorkflowDiagnostic[];
  source: 'builtin' | 'project' | 'user' | 'plugin';
  providerNames?: {
    claude?: string;
    codex?: string;
  };
}

export interface AgentWorkflowEntry extends SlashCommand {
  id: string;
  sourceType: AgentWorkflowSourceType;
  diagnostics?: WorkflowDiagnostic[];
}

interface ExtensionWorkflowSource {
  extensionId: string;
  displayName: string;
  description?: string;
  namespace: string;
  rootPath: string;
}

interface RegistrySnapshot {
  descriptors: AgentWorkflowDescriptor[];
  extensionWorkflowSources: ExtensionWorkflowSource[];
}

export interface AgentWorkflowQueryOptions {
  provider?: string | null;
  nativeCommands?: string[];
  nativeSkills?: string[];
  /**
   * Drop extension Claude-plugin commands (`source: 'plugin'`) from the result
   * (NIM-845). Set by the picker for a `claude-code-cli` session whose resolved
   * `claude` is too old to accept `--plugin-dir` (< 2.1.142): those plugins can't
   * load, so their namespaced commands (`/feedback:bug-report`, …) would never
   * resolve — offering them is a silent dead-end. When the CLI supports the flag
   * (or for the SDK `claude-code` path), leave this unset so plugin commands show.
   */
  excludePluginCommands?: boolean;
}

export interface AgentWorkflowServiceOptions {
  userHomePath?: string;
  extensionDirectoriesLoader?: () => Promise<string[]>;
  nativeClaudePluginPathsLoader?: (workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>;
  releaseChannelLoader?: () => ReleaseChannel;
}

const DEFAULT_CACHE_TTL_MS = 5000;

function isDirectoryEntry(entry: fs.Dirent, fullPath: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function isFileEntry(entry: fs.Dirent, fullPath: string): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

function sanitizeNamespace(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^com\./, '')
    .split('.')
    .pop()!
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';
}

function sanitizeCodexName(value: string): string {
  return value
    .trim()
    .replace(/[:/\\?%*|"<> ]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';
}

function sanitizeFileName(value: string): string {
  return sanitizeCodexName(value).toLowerCase();
}

function dedupePlugins(plugins: Array<{ type: 'local'; path: string }>): Array<{ type: 'local'; path: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ type: 'local'; path: string }> = [];

  for (const plugin of plugins) {
    const resolvedPath = path.resolve(plugin.path);
    if (seen.has(resolvedPath)) {
      continue;
    }
    seen.add(resolvedPath);
    deduped.push(plugin);
  }

  return deduped;
}

function isExtensionVisibleForChannel(
  manifest: { requiredReleaseChannel?: ReleaseChannel },
  currentChannel: ReleaseChannel
): boolean {
  const requiredChannel = manifest.requiredReleaseChannel;
  if (!requiredChannel || requiredChannel === 'stable') {
    return true;
  }
  if (requiredChannel === 'alpha') {
    return currentChannel === 'alpha';
  }
  return true;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function findContainingExtensionId(pluginPath: string): Promise<string | null> {
  let current = path.resolve(pluginPath);

  while (true) {
    const manifestPath = path.join(current, 'manifest.json');
    if (await pathExists(manifestPath)) {
      const manifest = await readJsonFile<{ id?: string }>(manifestPath);
      return manifest?.id ?? path.basename(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function readClaudePluginNamespace(pluginPath: string): Promise<string> {
  const pluginJson = await readJsonFile<{ name?: string }>(path.join(pluginPath, '.claude-plugin', 'plugin.json'));
  if (pluginJson?.name && pluginJson.name.trim()) {
    return pluginJson.name.trim();
  }
  return sanitizeNamespace(path.basename(pluginPath));
}

function renderCodexSkillMarkdown(descriptor: AgentWorkflowDescriptor, codexName: string): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push(`name: ${JSON.stringify(codexName)}`);
  if (descriptor.description) {
    lines.push(`description: ${JSON.stringify(descriptor.description)}`);
  }
  if (descriptor.argumentHint) {
    lines.push(`argument-hint: ${JSON.stringify(descriptor.argumentHint)}`);
  }
  if (descriptor.allowedTools && descriptor.allowedTools.length > 0) {
    lines.push(`allowed-tools: ${JSON.stringify(descriptor.allowedTools)}`);
  }
  lines.push('user-invocable: true');
  lines.push('---');
  lines.push('');
  lines.push(`# ${descriptor.title || codexName}`);
  lines.push('');
  lines.push(`Generated from ${descriptor.sourceType}.`);
  lines.push('');

  if (descriptor.kind === 'command') {
    lines.push(`Use this when the user explicitly invokes \`/${codexName}\` or requests the "${descriptor.name}" workflow.`);
    lines.push('');
    lines.push(renderCodexCommandInvocationNote(codexName, descriptor.argumentHint));
    lines.push('');
    lines.push('Follow this workflow:');
    lines.push('');
  } else {
    lines.push(`Use this when the user explicitly invokes \`/${codexName}\` or when the workflow fits implicitly.`);
    lines.push('');
  }

  if (descriptor.body?.trim()) {
    lines.push(
      descriptor.kind === 'command'
        ? rewriteCommandBodyForCodex(descriptor.body.trim(), codexName, descriptor.argumentHint)
        : descriptor.body.trim()
    );
    lines.push('');
  } else if (descriptor.description) {
    lines.push(descriptor.description);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function renderCodexCommandInvocationNote(codexName: string, argumentHint?: string): string {
  if (argumentHint) {
    return `Important: treat the text after \`/${codexName}\` as the command arguments ${argumentHint}. Use those arguments anywhere the original Claude command expects its argument placeholder.`;
  }

  return `Important: treat the text after \`/${codexName}\` as the command arguments. Use those arguments anywhere the original Claude command expects its argument placeholder.`;
}

function rewriteCommandBodyForCodex(body: string, codexName: string, argumentHint?: string): string {
  const standaloneReplacement = argumentHint
    ? `Use the invoking message text after \`/${codexName}\` as the command arguments ${argumentHint}. If the user did not provide explicit slash-command arguments, use the surrounding request text instead.`
    : `Use the invoking message text after \`/${codexName}\` as the command arguments. If the user did not provide explicit slash-command arguments, use the surrounding request text instead.`;

  return body
    .split('\n')
    .map((line) => {
      if (line.trim() === '$ARGUMENTS') {
        return standaloneReplacement;
      }

      return line.replace(/\$ARGUMENTS\b/g, "the user's command arguments");
    })
    .join('\n');
}

async function ensureFileMatches(targetPath: string, content: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });

  try {
    const existing = await fsp.readFile(targetPath);
    if (typeof content === 'string') {
      if (existing.toString('utf-8') === content) {
        return;
      }
    } else if (existing.equals(content)) {
      return;
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  if (typeof content === 'string') {
    await fsp.writeFile(targetPath, content, 'utf-8');
  } else {
    await fsp.writeFile(targetPath, content);
  }
}

async function removeUnexpectedEntries(
  targetDir: string,
  expectedNames: Set<string>,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(targetDir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (expectedNames.has(entry.name)) {
      continue;
    }
    await fsp.rm(path.join(targetDir, entry.name), { recursive: true, force: true });
  }
}

async function syncDirectoryRecursive(
  sourceDir: string,
  targetDir: string,
  options: { preserveNames?: Set<string> } = {},
): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  const expectedNames = new Set<string>([
    ...entries.map((entry) => entry.name),
    ...(options.preserveNames ?? []),
  ]);

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await syncDirectoryRecursive(sourcePath, targetPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      const realPath = await fsp.realpath(sourcePath);
      const stat = await fsp.stat(realPath);
      if (stat.isDirectory()) {
        await syncDirectoryRecursive(realPath, targetPath);
      } else {
        await ensureFileMatches(targetPath, await fsp.readFile(realPath));
      }
      continue;
    }

    await ensureFileMatches(targetPath, await fsp.readFile(sourcePath));
  }

  await removeUnexpectedEntries(targetDir, expectedNames);
}

export class AgentWorkflowService {
  private readonly workspacePath: string;
  private readonly userHomePath: string;
  private readonly extensionDirectoriesLoader: () => Promise<string[]>;
  private readonly nativeClaudePluginPathsLoader: (workspacePath?: string) => Promise<Array<{ type: 'local'; path: string }>>;
  private readonly releaseChannelLoader: () => ReleaseChannel;
  private cache: { snapshot: RegistrySnapshot; cacheTime: number } | null = null;
  private codexExportSyncPromise: Promise<void> | null = null;
  private claudePluginSyncPromise: Promise<string[]> | null = null;

  constructor(workspacePath: string, options: AgentWorkflowServiceOptions = {}) {
    this.workspacePath = workspacePath;
    this.userHomePath = options.userHomePath ?? homedir();
    this.extensionDirectoriesLoader = options.extensionDirectoriesLoader ?? getAllExtensionDirectories;
    this.nativeClaudePluginPathsLoader = options.nativeClaudePluginPathsLoader ?? getNativeClaudePluginPaths;
    this.releaseChannelLoader = options.releaseChannelLoader ?? getReleaseChannel;
  }

  clearCache(): void {
    this.cache = null;
  }

  async listEntries(options: AgentWorkflowQueryOptions = {}): Promise<AgentWorkflowEntry[]> {
    const provider = options.provider ?? 'claude-code';
    const snapshot = await this.getSnapshot();
    const exportSettings = getAgentWorkflowExportSettings();

    if (usesCodexStyleAgentWorkflows(provider) && exportSettings.codexEnabled) {
      await this.ensureCodexExportsSynced(snapshot);
    }

    if (provider === 'claude-code' && exportSettings.claudeGeneratedExtensionWorkflowsEnabled) {
      await this.ensureGeneratedClaudePluginsSynced(snapshot);
    }

    const providerEntries = [
      ...this.buildProviderNativeEntries(provider, options.nativeCommands ?? [], options.nativeSkills ?? []),
      ...this.buildDescriptorEntries(snapshot.descriptors, provider),
    ];

    const seenNames = new Set<string>();
    return providerEntries.filter(entry => {
      if (!entry.name || seenNames.has(entry.name)) {
        return false;
      }
      // NIM-845: on a claude-code-cli whose CLI can't load plugins, drop plugin
      // commands so the picker doesn't offer commands that will never resolve.
      if (options.excludePluginCommands && entry.source === 'plugin') {
        return false;
      }
      seenNames.add(entry.name);
      return true;
    });
  }

  async getEntryByName(name: string, options: AgentWorkflowQueryOptions = {}): Promise<AgentWorkflowEntry | null> {
    const entries = await this.listEntries(options);
    return entries.find(entry => entry.name === name) ?? null;
  }

  async getClaudeProviderPluginPaths(): Promise<Array<{ type: 'local'; path: string }>> {
    const nativePlugins = await this.nativeClaudePluginPathsLoader(this.workspacePath);
    const exportSettings = getAgentWorkflowExportSettings();

    if (!exportSettings.claudeGeneratedExtensionWorkflowsEnabled) {
      return dedupePlugins(nativePlugins);
    }

    const snapshot = await this.getSnapshot();
    const generatedPlugins = await this.ensureGeneratedClaudePluginsSynced(snapshot);
    return dedupePlugins([
      ...nativePlugins,
      ...generatedPlugins.map(pluginPath => ({ type: 'local' as const, path: pluginPath })),
    ]);
  }

  async ensureCodexExports(): Promise<void> {
    if (!getAgentWorkflowExportSettings().codexEnabled) {
      return;
    }
    const snapshot = await this.getSnapshot();
    await this.ensureCodexExportsSynced(snapshot);
  }

  private async ensureCodexExportsSynced(snapshot: RegistrySnapshot): Promise<void> {
    if (!this.codexExportSyncPromise) {
      this.codexExportSyncPromise = this.syncCodexExports(snapshot)
        .finally(() => {
          this.codexExportSyncPromise = null;
        });
    }
    await this.codexExportSyncPromise;
  }

  private async ensureGeneratedClaudePluginsSynced(snapshot: RegistrySnapshot): Promise<string[]> {
    if (!this.claudePluginSyncPromise) {
      this.claudePluginSyncPromise = this.syncGeneratedClaudePlugins(snapshot)
        .finally(() => {
          this.claudePluginSyncPromise = null;
        });
    }
    return await this.claudePluginSyncPromise;
  }

  private async getSnapshot(): Promise<RegistrySnapshot> {
    const now = Date.now();
    if (this.cache && (now - this.cache.cacheTime) < DEFAULT_CACHE_TTL_MS) {
      return this.cache.snapshot;
    }

    const snapshot = await this.buildSnapshot();
    this.cache = { snapshot, cacheTime: now };
    return snapshot;
  }

  private async buildSnapshot(): Promise<RegistrySnapshot> {
    const snapshot: RegistrySnapshot = {
      descriptors: [],
      extensionWorkflowSources: [],
    };
    const sourceSettings = getAgentWorkflowSourceSettings();

    if (sourceSettings.workspaceClaudeCompatibilityEnabled) {
      if (sourceSettings.includeProjectClaudeSources) {
        this.scanCommandDirectory(
          path.join(this.workspacePath, '.claude', 'commands'),
          path.join(this.workspacePath, '.claude', 'commands'),
          'project',
          'workspace-claude-command',
          snapshot.descriptors,
        );
        this.scanSkillDirectory(
          path.join(this.workspacePath, '.claude', 'skills'),
          path.join(this.workspacePath, '.claude', 'skills'),
          'project',
          'workspace-claude-skill',
          snapshot.descriptors,
        );
      }

      if (sourceSettings.includeUserClaudeSources) {
        const userCommandsPath = path.join(this.userHomePath, '.claude', 'commands');
        const userSkillsPath = path.join(this.userHomePath, '.claude', 'skills');
        this.scanCommandDirectory(
          userCommandsPath,
          userCommandsPath,
          'user',
          'workspace-claude-command',
          snapshot.descriptors,
        );
        this.scanSkillDirectory(
          userSkillsPath,
          userSkillsPath,
          'user',
          'workspace-claude-skill',
          snapshot.descriptors,
        );
      }
    }

    if (sourceSettings.extensionWorkflowsEnabled) {
      await this.scanExtensionWorkflowSources(snapshot);
    }

    // Always scan Claude CLI plugins (~/.claude/plugins) regardless of the
    // Nimbalyst extension-workflows toggle. The Claude Agent SDK auto-loads
    // these plugins based on the user's enabledPlugins settings, so the
    // Nimbalyst typeahead must mirror that to avoid showing plugin commands
    // only on the global panel but not on project-scoped workspaces.
    await this.scanLegacyClaudePluginSources(snapshot);

    return snapshot;
  }

  private async scanExtensionWorkflowSources(snapshot: RegistrySnapshot): Promise<void> {
    const extensionDirs = await this.extensionDirectoriesLoader();
    const releaseChannel = this.releaseChannelLoader();
    const seenExtensionIds = new Set<string>();

    for (const extensionsDir of extensionDirs) {
      let subdirs: fs.Dirent[];
      try {
        subdirs = await fsp.readdir(extensionsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const subdir of subdirs) {
        const extensionPath = path.join(extensionsDir, subdir.name);
        if (!isDirectoryEntry(subdir, extensionPath)) {
          continue;
        }

        const manifestPath = path.join(extensionPath, 'manifest.json');
        const manifest = await readJsonFile<{
          id?: string;
          name?: string;
          requiredReleaseChannel?: ReleaseChannel;
          contributions?: {
            agentWorkflows?: {
              path?: string;
              displayName?: string;
              description?: string;
              enabledByDefault?: boolean;
            };
          };
          defaultEnabled?: boolean;
        }>(manifestPath);
        if (!manifest) {
          continue;
        }

        const extensionId = manifest.id || subdir.name;
        if (seenExtensionIds.has(extensionId)) {
          continue;
        }
        seenExtensionIds.add(extensionId);

        if (!isExtensionVisibleForChannel(manifest, releaseChannel)) {
          continue;
        }

        if (!getExtensionEnabled(extensionId, manifest.defaultEnabled)) {
          continue;
        }

        const contribution = manifest.contributions?.agentWorkflows;
        if (!contribution?.path) {
          continue;
        }

        const enabled = getAgentWorkflowsEnabled(extensionId) ?? contribution.enabledByDefault ?? true;
        if (!enabled) {
          continue;
        }

        const workflowRoot = path.resolve(extensionPath, contribution.path);
        if (!await pathExists(workflowRoot)) {
          continue;
        }

        const namespace = sanitizeNamespace(extensionId);
        snapshot.extensionWorkflowSources.push({
          extensionId,
          displayName: contribution.displayName || manifest.name || extensionId,
          description: contribution.description,
          namespace,
          rootPath: workflowRoot,
        });

        const commandsRoot = path.join(workflowRoot, 'commands');
        const skillsRoot = path.join(workflowRoot, 'skills');
        this.scanCommandDirectory(
          commandsRoot,
          commandsRoot,
          'plugin',
          'extension-workflow',
          snapshot.descriptors,
          {
            sourceId: extensionId,
            namespace,
          },
        );
        this.scanSkillDirectory(
          skillsRoot,
          skillsRoot,
          'plugin',
          'extension-workflow',
          snapshot.descriptors,
          {
            sourceId: extensionId,
            namespace,
          },
        );
      }
    }
  }

  private async scanLegacyClaudePluginSources(snapshot: RegistrySnapshot): Promise<void> {
    const pluginRoots = await this.nativeClaudePluginPathsLoader(this.workspacePath);

    for (const plugin of pluginRoots) {
      const pluginRoot = path.resolve(plugin.path);
      if (!await pathExists(pluginRoot)) {
        continue;
      }

      const pluginNamespace = await readClaudePluginNamespace(pluginRoot);
      const extensionId = await findContainingExtensionId(pluginRoot);
      const sourceType: AgentWorkflowSourceType = 'legacy-claude-plugin';
      const sourceId = extensionId ?? pluginNamespace;

      const skillsRoot = path.join(pluginRoot, 'skills');
      this.scanSkillDirectory(
        skillsRoot,
        skillsRoot,
        'plugin',
        sourceType,
        snapshot.descriptors,
        {
          sourceId,
          namespace: pluginNamespace,
        },
      );

      this.scanClaudePluginCommands(pluginRoot, pluginNamespace, sourceType, sourceId, snapshot.descriptors);
    }
  }

  private scanClaudePluginCommands(
    pluginRoot: string,
    namespace: string,
    sourceType: AgentWorkflowSourceType,
    sourceId: string,
    descriptors: AgentWorkflowDescriptor[],
  ): void {
    if (!fs.existsSync(pluginRoot)) {
      return;
    }

    const recurse = (currentPath: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (isDirectoryEntry(entry, fullPath)) {
          if (entry.name === '.claude-plugin' || entry.name === 'skills') {
            continue;
          }
          recurse(fullPath);
          continue;
        }

        if (!isFileEntry(entry, fullPath) || !entry.name.endsWith('.md') || entry.name === 'SKILL.md') {
          continue;
        }

        const commandsRoot = path.join(pluginRoot, 'commands');
        const relativePath = fullPath.startsWith(`${commandsRoot}${path.sep}`)
          ? path.relative(commandsRoot, fullPath)
          : path.relative(pluginRoot, fullPath);
        const command = parseCommandFile(fullPath, 'plugin', relativePath);
        if (!command || !validateCommand(command)) {
          continue;
        }

        descriptors.push(this.toDescriptor(command, sourceType, {
          source: 'plugin',
          sourceId,
          namespace,
        }));
      }
    };

    recurse(pluginRoot);
  }

  private scanCommandDirectory(
    dirPath: string,
    rootPath: string,
    source: 'project' | 'user' | 'plugin',
    sourceType: AgentWorkflowSourceType,
    descriptors: AgentWorkflowDescriptor[],
    options: { sourceId?: string; namespace?: string } = {},
  ): void {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    const recurse = (currentPath: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (isDirectoryEntry(entry, fullPath)) {
          recurse(fullPath);
          continue;
        }

        if (!isFileEntry(entry, fullPath) || !entry.name.endsWith('.md')) {
          continue;
        }

        const relativePath = path.relative(rootPath, fullPath);
        const command = parseCommandFile(fullPath, source, relativePath);
        if (!command || !validateCommand(command)) {
          continue;
        }

        descriptors.push(this.toDescriptor(command, sourceType, {
          source,
          sourceId: options.sourceId,
          namespace: options.namespace,
        }));
      }
    };

    recurse(dirPath);
  }

  private scanSkillDirectory(
    dirPath: string,
    rootPath: string,
    source: 'project' | 'user' | 'plugin',
    sourceType: AgentWorkflowSourceType,
    descriptors: AgentWorkflowDescriptor[],
    options: { sourceId?: string; namespace?: string } = {},
  ): void {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    const recurse = (currentPath: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (isDirectoryEntry(entry, fullPath)) {
          recurse(fullPath);
          continue;
        }

        if (!isFileEntry(entry, fullPath) || entry.name !== 'SKILL.md') {
          continue;
        }

        const relativePath = path.relative(rootPath, fullPath);
        const skill = parseSkillFile(fullPath, source, relativePath);
        if (!skill || !validateCommand(skill) || skill.userInvocable === false) {
          continue;
        }

        descriptors.push(this.toDescriptor(skill, sourceType, {
          source,
          sourceId: options.sourceId,
          namespace: options.namespace,
        }));
      }
    };

    recurse(dirPath);
  }

  private toDescriptor(
    command: SlashCommand,
    sourceType: AgentWorkflowSourceType,
    options: {
      source: 'project' | 'user' | 'plugin';
      sourceId?: string;
      namespace?: string;
    },
  ): AgentWorkflowDescriptor {
    const namespace = options.namespace;
    const claudeName = namespace
      ? `${namespace}:${command.name}`
      : command.name;
    const codexBaseName = namespace
      ? `${namespace}-${command.name}`
      : command.name;
    const codexName = sanitizeCodexName(codexBaseName);
    const diagnostics: WorkflowDiagnostic[] = [];

    if (codexName !== codexBaseName) {
      diagnostics.push({
        code: 'codex-name-normalized',
        level: 'info',
        message: `Codex export normalizes "${codexBaseName}" to "${codexName}".`,
      });
    }

    return {
      id: `${sourceType}:${options.sourceId ?? options.source}:${command.kind ?? 'command'}:${claudeName}`,
      name: command.name,
      kind: command.kind ?? 'command',
      title: command.name,
      description: command.description,
      invocation: command.kind === 'skill' ? 'both' : 'explicit',
      sourceType,
      sourceId: options.sourceId ?? options.source,
      sourcePath: command.filePath,
      argumentHint: command.argumentHint,
      allowedTools: command.allowedTools,
      body: command.content,
      providerTargets: sourceType === 'provider-native' ? ['claude', 'ui'] : ['claude', 'codex', 'ui'],
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      source: options.source,
      providerNames: {
        claude: claudeName,
        codex: codexName,
      },
    };
  }

  private buildProviderNativeEntries(
    provider: string,
    nativeCommands: string[],
    nativeSkills: string[],
  ): AgentWorkflowEntry[] {
    const nativeSkillProviderLabel = provider === 'opencode'
      ? 'OpenCode'
      : usesCodexStyleAgentWorkflows(provider)
        ? 'Codex'
        : 'Claude';
    const commandDescriptions: Record<string, string> = usesCodexStyleAgentWorkflows(provider)
      ? {
          compact: 'Summarize the current conversation to free context while preserving key points',
          diff: 'Show the current Git diff, including untracked files',
          init: 'Generate an AGENTS.md scaffold for the current directory',
          mcp: 'List the configured MCP tools available in this Codex session',
          review: 'Ask Codex to review the current working tree',
          status: 'Display active model, sandbox, and session token usage information',
        }
      : {
          compact: 'Reduces conversation history by summarizing older messages',
          clear: 'Start a new conversation session',
          context: 'Show context information about the current session',
          cost: 'Display token usage and cost information for the session',
          init: 'Initialize or reinitialize the Claude Code session',
          'output-style:new': 'Create a new custom output style configuration',
          'pr-comments': 'Generate pull request comments for code changes',
          'release-notes': 'Generate release notes from recent changes',
          todos: 'Extract and manage TODO items from the codebase',
          review: 'Perform code review on recent changes',
          'security-review': 'Conduct security analysis of the codebase',
        };

    const entries: AgentWorkflowEntry[] = [];

    for (const name of nativeCommands) {
      entries.push({
        id: `provider-native:command:${name}`,
        name,
        description: commandDescriptions[name] || `Execute ${name} command`,
        source: 'builtin',
        kind: 'command',
        sourceType: 'provider-native',
      });
    }

    for (const name of nativeSkills) {
      entries.push({
        id: `provider-native:skill:${name}`,
        name,
        description: `Invoke the ${name} ${nativeSkillProviderLabel} skill`,
        source: 'plugin',
        kind: 'skill',
        sourceType: 'provider-native',
      });
    }

    return entries;
  }

  private buildDescriptorEntries(descriptors: AgentWorkflowDescriptor[], provider: string): AgentWorkflowEntry[] {
    const target = usesCodexStyleAgentWorkflows(provider) ? 'codex' : 'claude';

    return descriptors
      .filter(descriptor => descriptor.providerTargets.includes(target))
      .map(descriptor => {
        const providerName = target === 'codex'
          ? descriptor.providerNames?.codex || sanitizeCodexName(descriptor.name)
          : descriptor.providerNames?.claude || descriptor.name;

        return {
          id: descriptor.id,
          name: providerName,
          description: descriptor.description,
          argumentHint: descriptor.argumentHint,
          source: descriptor.source,
          kind: descriptor.kind,
          filePath: descriptor.sourcePath,
          allowedTools: descriptor.allowedTools,
          content: descriptor.body,
          sourceType: descriptor.sourceType,
          diagnostics: descriptor.diagnostics,
        };
      });
  }

  private async syncCodexExports(snapshot: RegistrySnapshot): Promise<void> {
    const generatedRoot = path.join(this.workspacePath, '.agents', 'skills', '.nimbalyst-generated');
    await fsp.mkdir(generatedRoot, { recursive: true });

    const exportedDescriptors = snapshot.descriptors
      .filter(descriptor => descriptor.providerTargets.includes('codex'));
    const seenNames = new Set<string>();
    const manifestEntries: Array<{ id: string; name: string; sourceType: AgentWorkflowSourceType }> = [];
    const expectedSkillDirs = new Set<string>();

    for (const descriptor of exportedDescriptors) {
      const codexName = descriptor.providerNames?.codex || sanitizeCodexName(descriptor.name);
      if (!codexName || seenNames.has(codexName)) {
        continue;
      }
      seenNames.add(codexName);

      const skillDirName = sanitizeFileName(codexName);
      const skillDir = path.join(generatedRoot, skillDirName);
      expectedSkillDirs.add(skillDirName);
      await fsp.mkdir(skillDir, { recursive: true });
      await ensureFileMatches(
        path.join(skillDir, 'SKILL.md'),
        renderCodexSkillMarkdown(descriptor, codexName),
      );
      await removeUnexpectedEntries(skillDir, new Set(['SKILL.md']));

      manifestEntries.push({
        id: descriptor.id,
        name: codexName,
        sourceType: descriptor.sourceType,
      });
    }

    await removeUnexpectedEntries(generatedRoot, new Set([...expectedSkillDirs, 'manifest.json']));
    await ensureFileMatches(
      path.join(generatedRoot, 'manifest.json'),
      JSON.stringify({
        entries: manifestEntries,
      }, null, 2),
    );
  }

  private async syncGeneratedClaudePlugins(snapshot: RegistrySnapshot): Promise<string[]> {
    const generatedRoot = path.join(this.workspacePath, '.claude', 'plugins', '.nimbalyst-generated');
    await fsp.mkdir(generatedRoot, { recursive: true });

    const pluginPaths: string[] = [];
    const expectedPluginDirs = new Set<string>();

    for (const source of snapshot.extensionWorkflowSources) {
      const pluginDirName = sanitizeFileName(source.namespace);
      const pluginRoot = path.join(generatedRoot, pluginDirName);
      expectedPluginDirs.add(pluginDirName);
      await syncDirectoryRecursive(source.rootPath, pluginRoot, {
        preserveNames: new Set(['.claude-plugin']),
      });
      await fsp.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
      await ensureFileMatches(
        path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: source.namespace,
          version: '1.0.0',
          description: source.description || source.displayName,
          author: { name: 'Nimbalyst' },
        }, null, 2),
      );
      await removeUnexpectedEntries(path.join(pluginRoot, '.claude-plugin'), new Set(['plugin.json']));
      pluginPaths.push(pluginRoot);
    }

    await removeUnexpectedEntries(generatedRoot, new Set([...expectedPluginDirs, 'manifest.json']));
    await ensureFileMatches(
      path.join(generatedRoot, 'manifest.json'),
      JSON.stringify({
        plugins: pluginPaths.map(pluginPath => path.basename(pluginPath)),
      }, null, 2),
    );

    return pluginPaths;
  }
}

const servicesByWorkspace = new Map<string, AgentWorkflowService>();

export function getAgentWorkflowService(workspacePath: string): AgentWorkflowService {
  let service = servicesByWorkspace.get(workspacePath);
  if (!service) {
    service = new AgentWorkflowService(workspacePath);
    servicesByWorkspace.set(workspacePath, service);
  }
  return service;
}
