import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentWorkflowService } from '../AgentWorkflowService';
import {
  setAgentWorkflowExportSettings,
  setAgentWorkflowSourceSettings,
} from '../../utils/store';

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
});
