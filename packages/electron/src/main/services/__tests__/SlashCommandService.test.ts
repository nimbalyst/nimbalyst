import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SlashCommandService } from '../SlashCommandService';

describe('SlashCommandService', () => {
  let workspacePath: string;
  let userHomePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-command-service-'));
    userHomePath = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-command-home-'));
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(userHomePath, { recursive: true, force: true });
  });

  it('includes project skills from .claude/skills in the slash command list', async () => {
    const skillsDir = path.join(workspacePath, '.claude', 'skills', 'workspace-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      `---
name: workspace-skill-test
description: Workspace skill for autocomplete coverage
argument-hint: [topic]
---

# Workspace Skill
`,
      'utf-8'
    );

    const service = new SlashCommandService(workspacePath, { userHomePath });
    const commands = await service.listCommands({ provider: 'claude-code' });
    const skill = commands.find(cmd => cmd.name === 'workspace-skill-test');

    expect(skill).toBeDefined();
    expect(skill?.kind).toBe('skill');
    expect(skill?.source).toBe('project');
    expect(skill?.argumentHint).toBe('[topic]');
  });

  it('hides skills with user-invocable: false from the slash command list', async () => {
    const skillsDir = path.join(workspacePath, '.claude', 'skills', 'hidden-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      `---
name: hidden-skill-test
description: Hidden skill for autocomplete coverage
user-invocable: false
---

# Hidden Skill
`,
      'utf-8'
    );

    const service = new SlashCommandService(workspacePath, { userHomePath });
    const commands = await service.listCommands({ provider: 'claude-code' });

    expect(commands.some(cmd => cmd.name === 'hidden-skill-test')).toBe(false);
  });

  it('includes project Codex skills from .agents/skills and extracts description from body text', async () => {
    const skillsDir = path.join(workspacePath, '.agents', 'skills', 'workspace-codex-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      `# Workspace Codex Skill

Use this when the user asks for a Codex-specific workflow from the current project.

## Steps
- Inspect the repository
`,
      'utf-8'
    );

    const service = new SlashCommandService(workspacePath, { userHomePath });
    const commands = await service.listCommands({ provider: 'openai-codex' });
    const skill = commands.find(cmd => cmd.name === 'workspace-codex-skill');

    expect(skill).toBeDefined();
    expect(skill?.kind).toBe('skill');
    expect(skill?.source).toBe('project');
    expect(skill?.description).toBe('Use this when the user asks for a Codex-specific workflow from the current project.');
  });

  it('scans generated Codex skills under .agents/skills/.nimbalyst-generated without exposing the namespace prefix', async () => {
    const generatedSkillDir = path.join(
      workspacePath,
      '.agents',
      'skills',
      '.nimbalyst-generated',
      'generated-review'
    );
    fs.mkdirSync(generatedSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(generatedSkillDir, 'SKILL.md'),
      `# Generated Review

Use this when the user invokes the generated review workflow.
`,
      'utf-8'
    );

    const service = new SlashCommandService(workspacePath, { userHomePath });
    const commands = await service.listCommands({ provider: 'openai-codex' });

    expect(commands.some(cmd => cmd.name === 'generated-review')).toBe(true);
    expect(commands.some(cmd => cmd.name.includes('.nimbalyst-generated'))).toBe(false);
  });

  it('keeps Codex slash discovery project-local only', async () => {
    const workspaceSkillsDir = path.join(workspacePath, '.agents', 'skills', 'project-codex-skill');
    fs.mkdirSync(workspaceSkillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceSkillsDir, 'SKILL.md'),
      `# Project Codex Skill

Use this when the user needs the project-local Codex skill.
`,
      'utf-8'
    );

    const userClaudeSkillDir = path.join(userHomePath, '.claude', 'skills', 'user-claude-skill');
    fs.mkdirSync(userClaudeSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(userClaudeSkillDir, 'SKILL.md'),
      `---
name: user-claude-skill
description: Should not appear in Codex discovery
---
`,
      'utf-8'
    );

    const service = new SlashCommandService(workspacePath, { userHomePath });
    const commands = await service.listCommands({ provider: 'openai-codex' });

    expect(commands.some(cmd => cmd.name === 'project-codex-skill')).toBe(true);
    expect(commands.some(cmd => cmd.name === 'user-claude-skill')).toBe(false);
  });

  it('surfaces the curated built-in Codex slash commands', async () => {
    const service = new SlashCommandService(workspacePath, { userHomePath });
    const commands = await service.listCommands({ provider: 'openai-codex' });
    const names = commands.map(cmd => cmd.name);

    expect(names).toEqual(expect.arrayContaining([
      'compact',
      'diff',
      'init',
      'mcp',
      'review',
      'status',
    ]));
  });
});
