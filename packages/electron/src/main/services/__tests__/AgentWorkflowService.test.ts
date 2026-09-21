import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentWorkflowService } from '../AgentWorkflowService';
import {
  setAgentWorkflowExportSettings,
  setAgentWorkflowSourceSettings,
} from '../../utils/store';

const CODEX_REVIEW_DESCRIPTION = 'Ask Codex to review the current working tree';

describe('AgentWorkflowService', () => {
  let workspacePath: string;
  let userHomePath: string;
  let extensionsDir: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflows-workspace-'));
    userHomePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflows-home-'));
    extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflows-extensions-'));
    setAgentWorkflowSourceSettings({
      workspaceClaudeCompatibilityEnabled: true,
      includeProjectClaudeSources: true,
      includeUserClaudeSources: false,
      extensionWorkflowsEnabled: true,
    });
    setAgentWorkflowExportSettings({
      codexEnabled: true,
      claudeGeneratedExtensionWorkflowsEnabled: true,
    });
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(userHomePath, { recursive: true, force: true });
    fs.rmSync(extensionsDir, { recursive: true, force: true });
    setAgentWorkflowSourceSettings({
      workspaceClaudeCompatibilityEnabled: false,
      includeProjectClaudeSources: false,
      includeUserClaudeSources: false,
      extensionWorkflowsEnabled: false,
    });
    setAgentWorkflowExportSettings({
      codexEnabled: false,
      claudeGeneratedExtensionWorkflowsEnabled: false,
    });
  });

  it('loads extension agentWorkflows into the picker and exports them for Claude and Codex', async () => {
    const extensionPath = path.join(extensionsDir, 'repair-tools');
    const workflowsPath = path.join(extensionPath, 'agent-workflows');

    fs.mkdirSync(path.join(workflowsPath, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(workflowsPath, 'skills', 'triage'), { recursive: true });

    fs.writeFileSync(
      path.join(extensionPath, 'manifest.json'),
      JSON.stringify({
        id: 'repair-tools',
        name: 'Repair Tools',
        version: '0.1.0',
        main: 'dist/index.mjs',
        apiVersion: '1.0.0',
        contributions: {
          agentWorkflows: {
            path: 'agent-workflows',
            displayName: 'Repair Tools Workflows',
          },
        },
      }, null, 2),
      'utf-8',
    );

    fs.writeFileSync(
      path.join(workflowsPath, 'commands', 'repair.md'),
      `---
description: Repair the current issue
argument-hint: [target]
---

Inspect the target issue, patch the code, and explain the fix.
`,
      'utf-8',
    );

    fs.writeFileSync(
      path.join(workflowsPath, 'skills', 'triage', 'SKILL.md'),
      `---
name: triage
description: Triage a bug before implementation
---

Review the issue, isolate the root cause, and prepare a fix plan.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [extensionsDir],
      nativeClaudePluginPathsLoader: async () => [],
      claudePluginInjectionLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const claudeEntries = await service.listEntries({
      provider: 'claude-code',
      nativeCommands: ['compact'],
    });

    expect(claudeEntries.some(entry => entry.name === 'repair-tools:repair')).toBe(true);
    expect(claudeEntries.some(entry => entry.name === 'repair-tools:triage')).toBe(true);
    expect(claudeEntries.some(entry => entry.name === 'compact')).toBe(true);

    const codexEntries = await service.listEntries({
      provider: 'openai-codex',
      nativeCommands: ['compact'],
    });

    expect(codexEntries.some(entry => entry.name === 'repair-tools-repair')).toBe(true);
    expect(codexEntries.some(entry => entry.name === 'repair-tools-triage')).toBe(true);

    const codexSkillPath = path.join(
      workspacePath,
      '.agents',
      'skills',
      '.nimbalyst-generated',
      'repair-tools-repair',
      'SKILL.md',
    );
    expect(fs.existsSync(codexSkillPath)).toBe(true);
    expect(fs.readFileSync(codexSkillPath, 'utf-8')).toContain('/repair-tools-repair');

    const pluginPaths = await service.getClaudeProviderPluginPaths();
    expect(pluginPaths).toHaveLength(1);

    const generatedPluginPath = pluginPaths[0].path;
    expect(fs.existsSync(path.join(generatedPluginPath, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(generatedPluginPath, 'commands', 'repair.md'))).toBe(true);
  });

  // #1213: the SDK reports every command/skill it discovered in `slash_commands`,
  // not just provider builtins, so those names collide with the files they came
  // from. The file must win, or the palette shows `Execute <name> command`.
  it('keeps frontmatter metadata when the SDK reports the same name as a native command', async () => {
    setAgentWorkflowSourceSettings({
      workspaceClaudeCompatibilityEnabled: true,
      includeProjectClaudeSources: true,
      includeUserClaudeSources: true,
      extensionWorkflowsEnabled: true,
    });

    const userSkillDir = path.join(userHomePath, '.claude', 'skills', 'deep-research');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSkillDir, 'SKILL.md'),
      `---
name: deep-research
description: Research a question across many sources and synthesize the findings
---

Sweep the sources, read the primaries, then synthesize.
`,
      'utf-8',
    );

    const commandsDir = path.join(workspacePath, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'investigate.md'),
      `---
description: Investigate a problem and align on the right next step
argument-hint: [problem]
---

Investigate first, then advise.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const entries = await service.listEntries({
      provider: 'claude-code',
      // The SDK lists the two discovered files alongside a genuine builtin.
      nativeCommands: ['investigate', 'deep-research', 'compact'],
      nativeSkills: ['deep-research'],
    });

    const skill = entries.find(entry => entry.name === 'deep-research');
    expect(skill?.description).toBe('Research a question across many sources and synthesize the findings');
    expect(skill?.source).toBe('user');
    expect(skill?.kind).toBe('skill');
    expect(skill?.content).toContain('Sweep the sources');
    expect(skill?.filePath).toBe(path.join(userSkillDir, 'SKILL.md'));

    const command = entries.find(entry => entry.name === 'investigate');
    expect(command?.description).toBe('Investigate a problem and align on the right next step');
    expect(command?.source).toBe('project');
    expect(command?.argumentHint).toBe('[problem]');

    // A builtin with no file behind it still comes through from the SDK list.
    const builtin = entries.find(entry => entry.name === 'compact');
    expect(builtin?.source).toBe('builtin');
    expect(builtin?.description).toBe('Reduces conversation history by summarizing older messages');
  });

  it('hides skills that opt out with user-invocable: false', async () => {
    const skillsDir = path.join(workspacePath, '.claude', 'skills', 'hidden-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      `---
name: hidden-skill-test
description: Model-invoked only, never offered in the palette
user-invocable: false
---

Run whenever the model decides it applies.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const entries = await service.listEntries({ provider: 'claude-code' });
    expect(entries.some(entry => entry.name === 'hidden-skill-test')).toBe(false);
  });

  it('extracts a fallback description from Claude command bodies before exporting to Codex skills', async () => {
    const commandsDir = path.join(workspacePath, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'design.md'),
      `---
packageVersion: 1.0.0
packageId: core
---

# /design Command

Create a new plan document for tracking work.

## Workflow

Inspect the codebase, write the plan, and capture open questions.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const codexEntries = await service.listEntries({ provider: 'openai-codex' });
    const designEntry = codexEntries.find(entry => entry.name === 'design');
    expect(designEntry?.description).toBe('Create a new plan document for tracking work.');

    const codexSkillPath = path.join(
      workspacePath,
      '.agents',
      'skills',
      '.nimbalyst-generated',
      'design',
      'SKILL.md',
    );
    const codexSkill = fs.readFileSync(codexSkillPath, 'utf-8');
    expect(codexSkill).toContain('description: "Create a new plan document for tracking work."');
  });

  it('treats OpenCode as a codex-style workflow consumer', async () => {
    const commandsDir = path.join(workspacePath, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'design.md'),
      `---
description: Create a design plan
---

Write a plan before implementation.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const entries = await service.listEntries({ provider: 'opencode' });
    expect(entries.some(entry => entry.name === 'design')).toBe(true);

    const exportedSkillPath = path.join(
      workspacePath,
      '.agents',
      'skills',
      '.nimbalyst-generated',
      'design',
      'SKILL.md',
    );
    expect(fs.existsSync(exportedSkillPath)).toBe(true);
    expect(fs.readFileSync(exportedSkillPath, 'utf-8')).toContain('/design');
  });

  it('rewrites Claude command argument placeholders into Codex-friendly guidance', async () => {
    const commandsDir = path.join(workspacePath, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'investigate.md'),
      `---
description: Investigate before implementing
argument-hint: [issue-or-problem]
---

# Investigate

## User's Problem Description

$ARGUMENTS
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    await service.listEntries({ provider: 'openai-codex' });

    const codexSkillPath = path.join(
      workspacePath,
      '.agents',
      'skills',
      '.nimbalyst-generated',
      'investigate',
      'SKILL.md',
    );
    const codexSkill = fs.readFileSync(codexSkillPath, 'utf-8');

    expect(codexSkill).toContain('Important: treat the text after `/investigate` as the command arguments [issue-or-problem].');
    expect(codexSkill).toContain('Use the invoking message text after `/investigate` as the command arguments [issue-or-problem].');
    expect(codexSkill).not.toContain('$ARGUMENTS');
  });

  it('imports legacy Claude plugins into the registry and exports command aliases for Codex', async () => {
    const pluginRoot = path.join(workspacePath, 'legacy-plugin');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'helper'), { recursive: true });

    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'legacy-tools',
        version: '0.1.0',
        description: 'Legacy tools',
        author: { name: 'Nimbalyst' },
      }, null, 2),
      'utf-8',
    );

    fs.writeFileSync(
      path.join(pluginRoot, 'commands', 'inspect.md'),
      `---
description: Inspect the current change
---

Read the diff, explain risks, and point out missing tests.
`,
      'utf-8',
    );

    fs.writeFileSync(
      path.join(pluginRoot, 'skills', 'helper', 'SKILL.md'),
      `---
name: helper
description: Helper skill
---

Use this when the user needs a helper workflow.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [{ type: 'local', path: pluginRoot }],
      releaseChannelLoader: () => 'stable',
    });

    const claudeEntries = await service.listEntries({ provider: 'claude-code' });
    expect(claudeEntries.some(entry => entry.name === 'legacy-tools:inspect')).toBe(true);
    expect(claudeEntries.some(entry => entry.name === 'legacy-tools:helper')).toBe(true);

    const codexEntries = await service.listEntries({ provider: 'openai-codex' });
    expect(codexEntries.some(entry => entry.name === 'legacy-tools-inspect')).toBe(true);
    expect(codexEntries.some(entry => entry.name === 'legacy-tools-helper')).toBe(true);
  });

  // #1465: Claude loads the user's `/plugin`-installed plugins itself. Handing
  // those same directories back as SDK `plugins` / CLI `--plugin-dir` entries
  // made a second, unconfigured `@inline` copy of each. Injection carries the
  // extension plugins (plus generated workflow plugins); discovery — what the
  // picker lists — still sees everything.
  it('injects extension and generated plugins only, while the picker still lists CLI-installed ones', async () => {
    const marketplacePluginRoot = path.join(workspacePath, 'marketplace-plugin');
    fs.mkdirSync(path.join(marketplacePluginRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(marketplacePluginRoot, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplacePluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'market-tools', version: '1.0.0', author: { name: 'Someone Else' } }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(marketplacePluginRoot, 'commands', 'status.md'),
      `---\ndescription: Report marketplace status\n---\n\nReport the status.\n`,
      'utf-8',
    );

    const extensionPluginRoot = path.join(extensionsDir, 'nim-ext', 'claude-plugin');
    fs.mkdirSync(path.join(extensionPluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionPluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'nim-ext', version: '0.1.0', author: { name: 'Nimbalyst' } }, null, 2),
      'utf-8',
    );

    // An extension workflow source so the generated plugin is part of the
    // injected set too — the CLI needs it to resolve generated commands.
    const workflowsPath = path.join(extensionsDir, 'nim-ext', 'agent-workflows');
    fs.mkdirSync(path.join(workflowsPath, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionsDir, 'nim-ext', 'manifest.json'),
      JSON.stringify({
        id: 'nim-ext',
        name: 'Nim Ext',
        version: '0.1.0',
        main: 'dist/index.mjs',
        apiVersion: '1.0.0',
        contributions: { agentWorkflows: { path: 'agent-workflows', displayName: 'Nim Ext Workflows' } },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workflowsPath, 'commands', 'tidy.md'),
      `---\ndescription: Tidy the workspace\n---\n\nTidy it.\n`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [extensionsDir],
      // Discovery sees both; injection is limited to the extension plugin.
      nativeClaudePluginPathsLoader: async () => [
        { type: 'local', path: marketplacePluginRoot },
        { type: 'local', path: extensionPluginRoot },
      ],
      claudePluginInjectionLoader: async () => [{ type: 'local', path: extensionPluginRoot }],
      releaseChannelLoader: () => 'stable',
    });

    const injected = (await service.getClaudeProviderPluginPaths()).map(plugin => plugin.path);

    expect(injected).toContain(extensionPluginRoot);
    expect(injected).not.toContain(marketplacePluginRoot);
    // The generated workflow plugin still ships, so `/nim-ext:tidy` resolves.
    const generated = injected.find(pluginPath =>
      pluginPath.startsWith(path.join(workspacePath, '.claude', 'plugins', '.nimbalyst-generated')),
    );
    expect(generated).toBeDefined();
    expect(fs.existsSync(path.join(generated!, 'commands', 'tidy.md'))).toBe(true);

    // Discovery is untouched: the CLI-installed plugin's command still lists.
    const entries = await service.listEntries({ provider: 'claude-code' });
    expect(entries.some(entry => entry.name === 'market-tools:status')).toBe(true);
  });

  // NIM-845: a claude-code-cli session whose resolved `claude` is too old to
  // accept `--plugin-dir` can't load extension Claude-plugins, so their namespaced
  // commands (`legacy-tools:inspect`) won't resolve. The picker must not offer
  // them — `excludePluginCommands` drops every `source: 'plugin'` entry while
  // keeping built-in / project / user commands. A CLI that DOES support the flag
  // (excludePluginCommands omitted/false) still sees them.
  it('hides plugin (namespaced) commands when excludePluginCommands is set (unsupported CLI), keeps them otherwise', async () => {
    const pluginRoot = path.join(workspacePath, 'legacy-plugin');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });

    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'legacy-tools', version: '0.1.0', author: { name: 'Nimbalyst' } }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'commands', 'inspect.md'),
      `---\ndescription: Inspect the current change\n---\n\nRead the diff.\n`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [{ type: 'local', path: pluginRoot }],
      releaseChannelLoader: () => 'stable',
    });

    // Supported CLI (flag omitted): the namespaced plugin command is offered.
    const supported = await service.listEntries({ provider: 'claude-code-cli' });
    expect(supported.some(entry => entry.name === 'legacy-tools:inspect')).toBe(true);

    // Unsupported CLI: plugin-sourced commands are filtered out entirely.
    const unsupported = await service.listEntries({
      provider: 'claude-code-cli',
      excludePluginCommands: true,
    });
    expect(unsupported.some(entry => entry.name === 'legacy-tools:inspect')).toBe(false);
    expect(unsupported.every(entry => entry.source !== 'plugin')).toBe(true);
  });

  it('deduplicates concurrent Codex export syncs', async () => {
    const extensionPath = path.join(extensionsDir, 'repair-tools');
    const workflowsPath = path.join(extensionPath, 'agent-workflows');

    fs.mkdirSync(path.join(workflowsPath, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionPath, 'manifest.json'),
      JSON.stringify({
        id: 'repair-tools',
        name: 'Repair Tools',
        version: '0.1.0',
        main: 'dist/index.mjs',
        apiVersion: '1.0.0',
        contributions: {
          agentWorkflows: {
            path: 'agent-workflows',
            displayName: 'Repair Tools Workflows',
          },
        },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workflowsPath, 'commands', 'repair.md'),
      `---
description: Repair the current issue
---

Inspect the target issue, patch the code, and explain the fix.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [extensionsDir],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const originalSync = (service as any).syncCodexExports.bind(service);
    let releaseSync!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      vi.spyOn(service as any, 'syncCodexExports').mockImplementation(async (snapshot: unknown) => {
        resolve();
        await new Promise<void>((release) => {
          releaseSync = release;
        });
        return await originalSync(snapshot);
      });
    });

    const first = service.listEntries({ provider: 'openai-codex' });
    const second = service.listEntries({ provider: 'openai-codex' });

    await syncStarted;
    expect((service as any).syncCodexExports).toHaveBeenCalledTimes(1);

    releaseSync();
    await Promise.all([first, second]);
  });

  it('deduplicates concurrent Claude plugin syncs', async () => {
    const extensionPath = path.join(extensionsDir, 'repair-tools');
    const workflowsPath = path.join(extensionPath, 'agent-workflows');

    fs.mkdirSync(path.join(workflowsPath, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionPath, 'manifest.json'),
      JSON.stringify({
        id: 'repair-tools',
        name: 'Repair Tools',
        version: '0.1.0',
        main: 'dist/index.mjs',
        apiVersion: '1.0.0',
        contributions: {
          agentWorkflows: {
            path: 'agent-workflows',
            displayName: 'Repair Tools Workflows',
          },
        },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workflowsPath, 'commands', 'repair.md'),
      `---
description: Repair the current issue
---

Inspect the target issue, patch the code, and explain the fix.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [extensionsDir],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const originalSync = (service as any).syncGeneratedClaudePlugins.bind(service);
    let releaseSync!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      vi.spyOn(service as any, 'syncGeneratedClaudePlugins').mockImplementation(async (snapshot: unknown) => {
        resolve();
        await new Promise<void>((release) => {
          releaseSync = release;
        });
        return await originalSync(snapshot);
      });
    });

    const first = service.listEntries({ provider: 'claude-code' });
    const second = service.listEntries({ provider: 'claude-code' });

    await syncStarted;
    expect((service as any).syncGeneratedClaudePlugins).toHaveBeenCalledTimes(1);

    releaseSync();
    await Promise.all([first, second]);
  });

  it('does not rewrite generated exports when workflows are unchanged', async () => {
    const extensionPath = path.join(extensionsDir, 'repair-tools');
    const workflowsPath = path.join(extensionPath, 'agent-workflows');

    fs.mkdirSync(path.join(workflowsPath, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionPath, 'manifest.json'),
      JSON.stringify({
        id: 'repair-tools',
        name: 'Repair Tools',
        version: '0.1.0',
        main: 'dist/index.mjs',
        apiVersion: '1.0.0',
        contributions: {
          agentWorkflows: {
            path: 'agent-workflows',
            displayName: 'Repair Tools Workflows',
          },
        },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workflowsPath, 'commands', 'repair.md'),
      `---
description: Repair the current issue
---

Inspect the target issue, patch the code, and explain the fix.
`,
      'utf-8',
    );

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [extensionsDir],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    await service.listEntries({ provider: 'openai-codex' });
    await service.listEntries({ provider: 'claude-code' });

    const codexSkillPath = path.join(
      workspacePath,
      '.agents',
      'skills',
      '.nimbalyst-generated',
      'repair-tools-repair',
      'SKILL.md',
    );
    const claudePluginJsonPath = path.join(
      workspacePath,
      '.claude',
      'plugins',
      '.nimbalyst-generated',
      'repair-tools',
      '.claude-plugin',
      'plugin.json',
    );

    const codexBefore = fs.statSync(codexSkillPath).mtimeMs;
    const claudeBefore = fs.statSync(claudePluginJsonPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 25));

    await service.listEntries({ provider: 'openai-codex' });
    await service.listEntries({ provider: 'claude-code' });

    expect(fs.statSync(codexSkillPath).mtimeMs).toBe(codexBefore);
    expect(fs.statSync(claudePluginJsonPath).mtimeMs).toBe(claudeBefore);
  });

  it('does not present an OpenCode config command as a built-in of ours', async () => {
    // OpenCode's native catalog only lists commands defined in OpenCode config,
    // so every one of them is someone's template. Labelling them `builtin` and
    // pasting a builtin's copy over them told the user a repository-controlled
    // /review was ours.
    setAgentWorkflowExportSettings({
      codexEnabled: false,
      claudeGeneratedExtensionWorkflowsEnabled: false,
    });
    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader: async () => [],
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const [namesOnly] = await service.listEntries({
      provider: 'opencode',
      nativeCommands: ['review'],
    });
    expect(namesOnly.source).not.toBe('builtin');
    expect(namesOnly.description).not.toBe(CODEX_REVIEW_DESCRIPTION);

    const [described] = await service.listEntries({
      provider: 'opencode',
      nativeCommands: [{
        name: 'review',
        description: 'Run the house review checklist',
        template: 'Review $ARGUMENTS against docs/review.md',
        agentName: 'reviewer',
        model: 'anthropic/claude-sonnet-4-5',
      }],
    });
    expect(described).toMatchObject({
      description: 'Run the house review checklist',
      content: 'Review $ARGUMENTS against docs/review.md',
      agentName: 'reviewer',
      model: 'anthropic/claude-sonnet-4-5',
    });

    // Codex keeps its own builtin copy: its native list really is builtins.
    const [codexReview] = await service.listEntries({
      provider: 'openai-codex',
      nativeCommands: ['review'],
    });
    expect(codexReview.source).toBe('builtin');
    expect(codexReview.description).toBe(CODEX_REVIEW_DESCRIPTION);
  });

  it('collapses N concurrent listEntries() calls into a single filesystem scan (startup burst)', async () => {
    // Regression test for the startup-contention investigation: multiple AI
    // tabs/panes each call ai:getAgentWorkflows on mount with no shared cache.
    // Before the fix, every call before the first buildSnapshot() resolves
    // races into its own full scan (observed: ~12 concurrent 8s scans at
    // startup, see nimbalyst-local/investigations/startup-contention.md).
    setAgentWorkflowExportSettings({
      codexEnabled: false,
      claudeGeneratedExtensionWorkflowsEnabled: false,
    });

    let resolveLoader: (dirs: string[]) => void = () => {};
    const loaderPromise = new Promise<string[]>((resolve) => { resolveLoader = resolve; });
    const extensionDirectoriesLoader = vi.fn(() => loaderPromise);

    const service = new AgentWorkflowService(workspacePath, {
      userHomePath,
      extensionDirectoriesLoader,
      nativeClaudePluginPathsLoader: async () => [],
      releaseChannelLoader: () => 'stable',
    });

    const calls = Array.from({ length: 5 }, () => service.listEntries({ provider: 'claude-code' }));
    resolveLoader([]);
    await Promise.all(calls);

    expect(extensionDirectoriesLoader).toHaveBeenCalledTimes(1);
  });
});
