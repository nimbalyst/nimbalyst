// NOTE: All onboarding configuration is now stored in WorkspaceState via Electron store.
// This eliminates the need for separate config.json files and ensures consistent persistence.

// Import types from shared location (safe for renderer process)
export type { OnboardingConfig } from '../../shared/types/workspace';
import { DEFAULT_ONBOARDING_CONFIG } from '../../shared/types/workspace';
import type { OnboardingConfig } from '../../shared/types/workspace';

export interface OnboardingStep {
  id: string;
  title: string;
  completed: boolean;
}

const DEFAULT_CONFIG = DEFAULT_ONBOARDING_CONFIG;

/**
 * Service for managing first-time user onboarding experience
 */
export class OnboardingService {
  private static instance: OnboardingService;
  private currentConfig: OnboardingConfig | null = null;

  private constructor() {}

  static getInstance(): OnboardingService {
    if (!OnboardingService.instance) {
      OnboardingService.instance = new OnboardingService();
    }
    return OnboardingService.instance;
  }

  /**
   * Check if a project needs onboarding
   */
  async needsOnboarding(workspacePath: string): Promise<boolean> {
    // Skip onboarding in Playwright tests
    if (window.PLAYWRIGHT || (window as any).PLAYWRIGHT) {
      console.log('Skipping onboarding (Playwright mode)');
      return false;
    }

    try {
      const config = await this.loadConfig(workspacePath);
      console.log(`${workspacePath} workspace onboarding needed: ${!config.onboardingCompleted}`);
      return !config.onboardingCompleted;
    } catch (error) {
      // If config doesn't exist or can't be read, assume onboarding is needed
      console.log('Onboarding config not found, onboarding needed', error);
      return true;
    }
  }

  /**
   * Load onboarding configuration from workspace state
   */
  async loadConfig(workspacePath: string): Promise<OnboardingConfig> {
    try {
      const state = await window.electronAPI.invoke('workspace:get-state', workspacePath);

      if (!state?.onboarding) {
        this.currentConfig = { ...DEFAULT_CONFIG };
        return this.currentConfig;
      }

      const config = state.onboarding;

      // Migrate old configs that don't have commandsLocation
      if (!config.commandsLocation) {
        config.commandsLocation = 'project';
      }

      this.currentConfig = config;
      return config;
    } catch (error) {
      console.log('No existing onboarding config, using defaults', error);
      this.currentConfig = { ...DEFAULT_CONFIG };
      return this.currentConfig;
    }
  }

  /**
   * Save onboarding configuration to workspace state
   */
  async saveConfig(workspacePath: string, config: OnboardingConfig): Promise<void> {
    try {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        onboarding: config
      });

      this.currentConfig = config;
    } catch (error) {
      console.error('Failed to save onboarding config:', error);
      throw error;
    }
  }

  /**
   * Mark onboarding as shown (called when dialog is displayed)
   * This prevents the dialog from showing again, even if dismissed
   */
  async markOnboardingShown(workspacePath: string): Promise<void> {
    const config = this.currentConfig || (await this.loadConfig(workspacePath));
    config.onboardingCompleted = true;
    await this.saveConfig(workspacePath, config);
  }

  /**
   * Mark onboarding as completed
   */
  async completeOnboarding(workspacePath: string): Promise<void> {
    const config = this.currentConfig || (await this.loadConfig(workspacePath));
    config.onboardingCompleted = true;
    await this.saveConfig(workspacePath, config);
  }


  /**
   * Install /track command file
   */
  async installTrackCommand(workspacePath: string): Promise<void> {
    const config = this.currentConfig || await this.loadConfig(workspacePath);
    const isGlobal = config.commandsLocation === 'global';
    const relativePath = 'commands/track.md';

    try {
      // Check if track.md already exists
      try {
        if (isGlobal) {
          const result = await window.electronAPI.invoke('read-global-claude-file', relativePath);
          if (result && result.success) {
            console.log('track.md already exists in ~/.claude/, skipping installation');
            return;
          }
        } else {
          const existing = await window.electronAPI.readFileContent(`${workspacePath}/.claude/commands/track.md`);
          if (existing && existing.success) {
            console.log('track.md already exists in project .claude/, skipping installation');
            return;
          }
        }
      } catch (err) {
        // File doesn't exist, continue with installation
      }

      // Write track command template
      const template = this.getTrackCommandTemplate();
      if (isGlobal) {
        await window.electronAPI.invoke('write-global-claude-file', relativePath, template);
      } else {
        await window.electronAPI.invoke('create-document', `.claude/${relativePath}`, template);
      }

      // Update config
      if (this.currentConfig) {
        this.currentConfig.claudeCodeIntegration.trackCommandInstalled = true;
        await this.saveConfig(workspacePath, this.currentConfig);
      }
    } catch (error) {
      console.error('Failed to install track command:', error);
      throw error;
    }
  }

  /**
   * Install /track-bug command file
   */
  async installTrackBugCommand(workspacePath: string): Promise<void> {
    const config = this.currentConfig || await this.loadConfig(workspacePath);
    const isGlobal = config.commandsLocation === 'global';
    const relativePath = 'commands/track-bug.md';

    try {
      // Check if track-bug.md already exists
      try {
        if (isGlobal) {
          const result = await window.electronAPI.invoke('read-global-claude-file', relativePath);
          if (result && result.success) {
            console.log('track-bug.md already exists in ~/.claude/, skipping installation');
            return;
          }
        } else {
          const existing = await window.electronAPI.readFileContent(`${workspacePath}/.claude/commands/track-bug.md`);
          if (existing && existing.success) {
            console.log('track-bug.md already exists in project .claude/, skipping installation');
            return;
          }
        }
      } catch (err) {
        // File doesn't exist, continue with installation
      }

      // Write track-bug command template
      const template = this.getTrackBugCommandTemplate();
      if (isGlobal) {
        await window.electronAPI.invoke('write-global-claude-file', relativePath, template);
      } else {
        await window.electronAPI.invoke('create-document', `.claude/${relativePath}`, template);
      }
    } catch (error) {
      console.error('Failed to install track-bug command:', error);
      throw error;
    }
  }

  /**
   * Install /track-idea command file
   */
  async installTrackIdeaCommand(workspacePath: string): Promise<void> {
    const config = this.currentConfig || await this.loadConfig(workspacePath);
    const isGlobal = config.commandsLocation === 'global';
    const relativePath = 'commands/track-idea.md';

    try {
      // Check if track-idea.md already exists
      try {
        if (isGlobal) {
          const result = await window.electronAPI.invoke('read-global-claude-file', relativePath);
          if (result && result.success) {
            console.log('track-idea.md already exists in ~/.claude/, skipping installation');
            return;
          }
        } else {
          const existing = await window.electronAPI.readFileContent(`${workspacePath}/.claude/commands/track-idea.md`);
          if (existing && existing.success) {
            console.log('track-idea.md already exists in project .claude/, skipping installation');
            return;
          }
        }
      } catch (err) {
        // File doesn't exist, continue with installation
      }

      // Write track-idea command template
      const template = this.getTrackIdeaCommandTemplate();
      if (isGlobal) {
        await window.electronAPI.invoke('write-global-claude-file', relativePath, template);
      } else {
        await window.electronAPI.invoke('create-document', `.claude/${relativePath}`, template);
      }
    } catch (error) {
      console.error('Failed to install track-idea command:', error);
      throw error;
    }
  }

  /**
   * Configure CLAUDE.md file
   */
  async configureCLAUDEmd(workspacePath: string): Promise<void> {
    const claudeMdPath = `${workspacePath}/CLAUDE.md`;
    const relativePath = 'CLAUDE.md'; // Relative to workspace

    try {
      const preditorSection = this.getCLAUDEmdSection();
      let finalContent: string;

      // Try to read existing file
      try {
        const result = await window.electronAPI.readFileContent(claudeMdPath);
        if (result && result.success) {
          // File exists, append to it
          const content = result.content;

          // Check if Nimbalyst section already exists
          if (content.includes('## Nimbalyst Planning System')) {
            console.log('CLAUDE.md already has Nimbalyst section, skipping');
            return;
          }

          finalContent = content + '\n\n' + preditorSection;
        } else {
          // File doesn't have content, create new
          finalContent = `# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

${preditorSection}`;
        }
      } catch (err) {
        // File doesn't exist, create new
        finalContent = `# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

${preditorSection}`;
      }

      // Write the file (create-document expects relative path)
      await window.electronAPI.invoke('create-document', relativePath, finalContent);

      // Update config
      if (this.currentConfig) {
        this.currentConfig.claudeCodeIntegration.claudeMdConfigured = true;
        await this.saveConfig(workspacePath, this.currentConfig);
      }
    } catch (error) {
      console.error('Failed to configure CLAUDE.md:', error);
      throw error;
    }
  }

  /**
   * Create plans directory if it doesn't exist
   */
  async ensurePlansDirectory(workspacePath: string, plansLocation?: string): Promise<void> {
    const config = this.currentConfig || (await this.loadConfig(workspacePath));
    const location = plansLocation || config.plansLocation;

    // Create a dummy file to ensure directory exists
    // Use relative path - create-document handler will join with workspace path
    const relativePath = `${location}/.gitkeep`;
    try {
      await window.electronAPI.invoke('create-document', relativePath, '');
    } catch (error) {
      console.error('Failed to create plans directory:', error);
    }
  }

  /**
   * Create an example plan document
   */
  async createExamplePlan(workspacePath: string): Promise<string> {
    const config = this.currentConfig || (await this.loadConfig(workspacePath));
    await this.ensurePlansDirectory(workspacePath);

    // Use relative path - create-document handler will join with workspace path
    const relativePath = `${config.plansLocation}/example-feature.md`;
    const template = this.getExamplePlanTemplate();

    try {
      await window.electronAPI.invoke('create-document', relativePath, template);
      // Return absolute path for caller
      return `${workspacePath}/${relativePath}`;
    } catch (error) {
      console.error('Failed to create example plan:', error);
      throw error;
    }
  }

  /**
   * Configure .gitignore to exclude plans directory if needed
   */
  async configureGitignore(workspacePath: string, plansDirectory?: string): Promise<void> {
    const config = this.currentConfig || (await this.loadConfig(workspacePath));
    const directory = plansDirectory || config.plansLocation.split('/')[0];

    const gitignorePath = `${workspacePath}/.gitignore`;
    const ignoreEntry = `\n# Nimbalyst local plans (not checked into version control)\n${directory}/\n`;

    try {
      // Try to read existing .gitignore
      let content = '';
      try {
        const result = await window.electronAPI.readFileContent(gitignorePath);
        if (result && result.success) {
          content = result.content;
        }
      } catch (err) {
        // File doesn't exist, will create it
      }

      // Check if entry already exists
      if (content.includes(`${directory}/`)) {
        console.log('.gitignore already has entry for plans directory');
        return;
      }

      // Append the ignore entry
      const finalContent = content + ignoreEntry;
      // Use relative path - create-document handler will join with workspace path
      await window.electronAPI.invoke('create-document', '.gitignore', finalContent);
    } catch (error) {
      console.error('Failed to configure .gitignore:', error);
      // Don't throw - this is not critical
    }
  }


  /**
   * Get track command template
   */
  private getTrackCommandTemplate(): string {
    return `# /track Command

Create a tracking item (bug, task, idea, or decision) in the appropriate tracking document.

## Tracking System Overview

Tracking items are organized by type in \`nimbalyst-local/tracker/\`:
- **Bugs** (bugs.md): Issues and defects that need fixing
- **Tasks** (tasks.md): Work items and todos
- **Ideas** (ideas.md): Feature ideas and improvements
- **Decisions** (decisions.md): Architecture and design decisions

## Context-Aware Placement

The command should intelligently choose where to place tracking items:

1. **In current plan document** - If working within a plan file (has \`planStatus\` frontmatter), add the item to a relevant section (e.g., "Known Issues", "Tasks", "Ideas")
2. **In related plan document** - If the item relates to a specific feature/component, check for a plan document for that feature in the plans directory
3. **In global tracker** - Default to \`nimbalyst-local/tracker/[type]s.md\` for general items

This keeps related items together for better context and organization.

## Tracking Item Structure

Each tracking item uses inline tracker syntax:

\`\`\`markdown
- [Brief description] #[type][id:[type]_[ulid] status:to-do priority:medium created:YYYY-MM-DD]
\`\`\`

### Required Fields

| Field | Format | Description |
|-------|--------|-------------|
| \`id\` | \`[type]_[ulid]\` | Unique identifier (bug_, task_, ida_, dec_) |
| \`status\` | \`to-do\|in-progress\|done\` | Current status |
| \`priority\` | \`low\|medium\|high\|critical\` | Item priority |
| \`created\` | \`YYYY-MM-DD\` | Creation date |

### Optional Fields

| Field | Format | Description |
|-------|--------|-------------|
| \`title\` | \`"Title text"\` | Explicit title (if different from line text) |
| \`updated\` | \`YYYY-MM-DDTHH:MM:SS.sssZ\` | Last update timestamp (ISO 8601) |
| \`assignee\` | \`username\` | Person responsible |

## ULID Generation

Generate a unique ULID (Universally Unique Lexicographically Sortable Identifier):

- **Format**: 26 characters, Base32 encoded
- **Character set**: 0-9, A-Z (excluding I, L, O, U)
- **Structure**: 10 chars timestamp + 16 chars random
- **Example**: \`01HQXYZ7890ABCDEF12345\`

**ID Prefixes by type**:
- Bugs: \`bug_01HQXYZ7890ABCDEF12345\`
- Tasks: \`task_01HQXYZ7890ABCDEF12345\`
- Ideas: \`ida_01HQXYZ7890ABCDEF12345\`
- Decisions: \`dec_01HQXYZ7890ABCDEF12345\`

## Examples

### Bug
\`\`\`markdown
- Login button doesn't work on mobile Safari #bug[id:bug_01HQXYZ7890ABCDEF12345 status:to-do priority:high created:2025-10-24]
\`\`\`

### Task
\`\`\`markdown
- Update documentation for API endpoints #task[id:task_01HQXYZ7890ABCDEF12346 status:in-progress priority:medium created:2025-10-24]
\`\`\`

### Idea
\`\`\`markdown
- Add dark mode to settings panel #idea[id:ida_01HQXYZ7890ABCDEF12347 status:to-do priority:low created:2025-10-24]
\`\`\`

### Decision
\`\`\`markdown
- Use PostgreSQL for data persistence #decision[id:dec_01HQXYZ7890ABCDEF12348 status:done priority:high created:2025-10-20]
\`\`\`

## Status Values
- \`to-do\`: Newly created, not yet started
- \`in-progress\`: Currently being worked on
- \`blocked\`: Blocked by dependencies or issues
- \`done\`: Work completed
- \`wont-fix\`: Decided not to address (bugs/tasks)

## Usage

When the user types \`/track [type] [description]\`:

Where \`[type]\` is one of: \`bug\`, \`task\`, \`idea\`, or \`decision\`

1. **Parse the type** from the command
2. **Generate ULID** for the unique item ID
3. **Determine priority** based on description
4. **Add to appropriate tracker file** in \`nimbalyst-local/tracker/[type]s.md\`
5. **Confirm** to the user where the item was tracked

**Examples:**
- \`/track bug Login fails on mobile Safari\`
- \`/track task Update API documentation\`
- \`/track idea Add dark mode support\`
- \`/track decision Use TypeScript for new modules\`

## Priority Guidelines

- **Critical**: System down, data loss, security vulnerability, must-have feature
- **High**: Major feature broken, high-value feature, important decision
- **Medium**: Feature partially broken, nice to have, standard task
- **Low**: Minor issue, cosmetic problem, low-priority enhancement

## Related Commands

- \`/design [description]\` - Create a feature plan (see .claude/commands/design.md)

## Best Practices

- **Always generate new ULIDs** - Never hardcode or reuse IDs
- **Include creation date** - Required for all new items
- **Default to medium priority** - Unless user specifies otherwise
- **Preserve file formatting** - Maintain existing structure
- **Group related items** - Keep items organized by section
- **Update timestamps** - Set \`updated\` field when modifying items
- **Move completed items** - Move to "Completed" section when done`;
  }

  /**
   * Get track-bug command template
   */
  private getTrackBugCommandTemplate(): string {
    return `# /track-bug Command

Track a bug using Nimbalyst's inline tracker syntax.

## Overview

The \`/track-bug\` command creates bug tracking items using a lightweight inline syntax. Bugs can be tracked in dedicated tracker files or directly within plan documents for context-aware organization.

## Context-Aware Bug Tracking

The command automatically determines the best location for the bug:

### 1. In Current Plan Document
If you're working on a plan document (has \`planStatus\` frontmatter):
- Bug is added to the current plan file
- Added in a relevant section (e.g., "Bugs", "Known Issues", "Problems")
- If no such section exists, creates "## Known Issues" section

### 2. In Related Feature Plan
If the bug is related to a specific feature/component:
- Checks for a plan document for that feature in \`nimbalyst-local/plans/\`
- If found, adds the bug there for context

### 3. In Global Bug Tracker
Otherwise (general bug or no specific context):
- Adds to \`nimbalyst-local/tracker/bugs.md\`
- Creates the file with proper structure if it doesn't exist

## Bug Tracker Syntax

Use inline tracker syntax with \`#bug\` prefix:

\`\`\`markdown
- [Brief bug description] #bug[id:bug_[ulid] status:to-do priority:medium created:YYYY-MM-DD]
\`\`\`

### Required Fields

| Field | Format | Description |
|-------|--------|-------------|
| \`id\` | \`bug_[ulid]\` | Unique identifier (26-char ULID) |
| \`status\` | \`to-do\|in-progress\|done\` | Current status |
| \`priority\` | \`low\|medium\|high\|critical\` | Bug severity |
| \`created\` | \`YYYY-MM-DD\` | Creation date |

### Optional Fields

| Field | Format | Description |
|-------|--------|-------------|
| \`title\` | \`"Title text"\` | Explicit title (if different from line text) |
| \`updated\` | \`YYYY-MM-DDTHH:MM:SS.sssZ\` | Last update timestamp (ISO 8601) |

## ULID Generation

Generate a unique ULID (Universally Unique Lexicographically Sortable Identifier):

- **Format**: 26 characters, Base32 encoded
- **Character set**: 0-9, A-Z (excluding I, L, O, U)
- **Structure**: 10 chars timestamp + 16 chars random
- **Example**: \`01HQXYZ7890ABCDEF12345\`
- **Full bug ID**: \`bug_01HQXYZ7890ABCDEF12345\`

**Why ULID?**
- Lexicographically sortable (sorts by creation time)
- No central coordination needed
- URL-safe and case-insensitive
- More compact than UUIDs

## Examples

### Simple Bug
\`\`\`markdown
- Login button doesn't work on mobile Safari #bug[id:bug_01HQXYZ7890ABCDEF12345 status:to-do priority:high created:2025-10-24]
\`\`\`

### Bug with Explicit Title
\`\`\`markdown
- Safari mobile login issue #bug[id:bug_01HQXYZ7890ABCDEF12346 status:in-progress priority:high created:2025-10-24 title:"Mobile Safari Login Failure"]
\`\`\`

### Bug with Update Timestamp
\`\`\`markdown
- API timeout on large requests #bug[id:bug_01HQXYZ7890ABCDEF12347 status:to-do priority:critical created:2025-10-24 updated:2025-10-24T14:30:00.000Z]
\`\`\`

### Completed Bug
\`\`\`markdown
- Memory leak in image loader #bug[id:bug_01HQXYZ7890ABCDEF12348 status:done priority:high created:2025-10-20 updated:2025-10-24T16:00:00.000Z]
\`\`\`

## Bug Tracker File Structure

If creating \`nimbalyst-local/tracker/bugs.md\`, use this template:

\`\`\`markdown
# Bugs

## Active Bugs

- [New and in-progress bugs with #bug syntax]

## Completed Bugs

- [Completed bugs with status:done]
\`\`\`

## Usage Workflow

When the user types \`/track-bug [description]\`:

1. **Extract bug details** from the user's description
2. **Determine location** based on context (plan, related feature, or global tracker)
3. **Generate ULID** for the unique bug ID
4. **Create bug entry** with proper inline syntax
5. **Add to appropriate section** in the target file
6. **Confirm** to the user where the bug was tracked

## Priority Guidelines

Choose priority based on impact:

- **Critical**: System down, data loss, security vulnerability
- **High**: Major feature broken, affects many users
- **Medium**: Feature partially broken, workaround exists
- **Low**: Minor issue, cosmetic problem, edge case

## Status Transitions

Typical bug lifecycle:

\`\`\`
to-do → in-progress → done
         ↓
      blocked (if stuck)
\`\`\`

## Related Commands

- \`/design [description]\` - Create a feature plan (see .claude/commands/design.md)
- \`/track-idea [description]\` - Track an idea (see .claude/commands/track-idea.md)

## Best Practices

- **Always generate new ULIDs** - Never hardcode or reuse IDs
- **Include creation date** - Required for all new bugs
- **Default to medium priority** - Unless user specifies otherwise
- **Preserve file formatting** - Maintain existing structure and styling
- **Group related bugs** - Keep bugs near related content in plans
- **Update timestamps** - Set \`updated\` field when modifying bugs
- **Move completed bugs** - Move to "Completed" section when done`;
  }

  /**
   * Get track-idea command template
   */
  private getTrackIdeaCommandTemplate(): string {
    return `# /track-idea Command

Track a feature idea using Nimbalyst's inline tracker syntax.

## Overview

The \`/track-idea\` command creates idea tracking items for feature requests, improvements, and enhancements. Ideas can be tracked in dedicated files or within plan documents for context-aware organization.

## Context-Aware Idea Tracking

The command automatically determines the best location for the idea:

### 1. In Current Plan Document
If you're working on a plan document (has \`planStatus\` frontmatter):
- Idea is added to the current plan file
- Added in a relevant section (e.g., "Ideas", "Future Enhancements", "Improvements")
- If no such section exists, creates "## Future Ideas" section

### 2. In Related Feature Plan
If the idea is related to a specific feature/component:
- Checks for a plan document for that feature in \`nimbalyst-local/plans/\`
- If found, adds the idea there for context

### 3. In Global Ideas Tracker
Otherwise (general idea or no specific context):
- Adds to \`nimbalyst-local/tracker/ideas.md\`
- Creates the file with proper structure if it doesn't exist

## Idea Tracker Syntax

Use inline tracker syntax with \`#idea\` prefix:

\`\`\`markdown
- [Brief idea description] #idea[id:ida_[ulid] status:to-do priority:medium created:YYYY-MM-DD]
\`\`\`

### Required Fields

| Field | Format | Description |
|-------|--------|-------------|
| \`id\` | \`ida_[ulid]\` | Unique identifier (26-char ULID) |
| \`status\` | \`to-do\|in-progress\|done\` | Current status |
| \`priority\` | \`low\|medium\|high\|critical\` | Idea importance |
| \`created\` | \`YYYY-MM-DD\` | Creation date |

### Optional Fields

| Field | Format | Description |
|-------|--------|-------------|
| \`title\` | \`"Title text"\` | Explicit title (if different from line text) |
| \`updated\` | \`YYYY-MM-DDTHH:MM:SS.sssZ\` | Last update timestamp (ISO 8601) |

## ULID Generation

Generate a unique ULID (Universally Unique Lexicographically Sortable Identifier):

- **Format**: 26 characters, Base32 encoded
- **Character set**: 0-9, A-Z (excluding I, L, O, U)
- **Structure**: 10 chars timestamp + 16 chars random
- **Example**: \`01HQXYZ7890ABCDEF12345\`
- **Full idea ID**: \`ida_01HQXYZ7890ABCDEF12345\`

**Why ULID?**
- Lexicographically sortable (sorts by creation time)
- No central coordination needed
- URL-safe and case-insensitive
- More compact than UUIDs

## Examples

### Simple Idea
\`\`\`markdown
- Add dark mode to settings panel #idea[id:ida_01HQXYZ7890ABCDEF12345 status:to-do priority:medium created:2025-10-24]
\`\`\`

### Idea with Explicit Title
\`\`\`markdown
- Dark mode settings #idea[id:ida_01HQXYZ7890ABCDEF12346 status:in-progress priority:high created:2025-10-24 title:"Dark Mode Theme Switcher"]
\`\`\`

### Idea with Update Timestamp
\`\`\`markdown
- Add keyboard shortcuts for common actions #idea[id:ida_01HQXYZ7890ABCDEF12347 status:to-do priority:low created:2025-10-24 updated:2025-10-24T14:30:00.000Z]
\`\`\`

### Implemented Idea
\`\`\`markdown
- Auto-save draft messages #idea[id:ida_01HQXYZ7890ABCDEF12348 status:done priority:high created:2025-10-20 updated:2025-10-24T16:00:00.000Z]
\`\`\`

## Ideas Tracker File Structure

If creating \`nimbalyst-local/tracker/ideas.md\`, use this template:

\`\`\`markdown
# Ideas

## Active Ideas

- [New and in-progress ideas with #idea syntax]

## Implemented Ideas

- [Implemented ideas with status:done]
\`\`\`

## Usage Workflow

When the user types \`/track-idea [description]\`:

1. **Extract idea details** from the user's description
2. **Determine location** based on context (plan, related feature, or global tracker)
3. **Generate ULID** for the unique idea ID
4. **Create idea entry** with proper inline syntax
5. **Add to appropriate section** in the target file
6. **Confirm** to the user where the idea was tracked

## Priority Guidelines

Choose priority based on value and effort:

- **Critical**: Must-have feature, competitive necessity
- **High**: High-value feature, significant user benefit
- **Medium**: Nice to have, moderate value
- **Low**: Minor enhancement, low priority

## Status Transitions

Typical idea lifecycle:

\`\`\`
to-do → in-progress → done
   ↓
rejected (if decided not to implement)
\`\`\`

## Related Commands

- \`/design [description]\` - Create a feature plan (see .claude/commands/design.md)
- \`/track-bug [description]\` - Track a bug (see .claude/commands/track-bug.md)

## Best Practices

- **Always generate new ULIDs** - Never hardcode or reuse IDs
- **Include creation date** - Required for all new ideas
- **Default to medium priority** - Unless user specifies otherwise
- **Preserve file formatting** - Maintain existing structure and styling
- **Group related ideas** - Keep ideas near related content in plans
- **Update timestamps** - Set \`updated\` field when modifying ideas
- **Move implemented ideas** - Move to "Implemented" section when done
- **Convert to plans** - Promote high-value ideas to full plan documents`;
  }

  /**
   * Get CLAUDE.md section to add
   */
  private getCLAUDEmdSection(): string {
    const config = this.currentConfig;
    const plansLocation = config?.plansLocation || 'plans';
    const commandsLocation = config?.commandsLocation === 'global' ? '~/.claude' : '.claude';

    return `## Nimbalyst Planning System

This project uses Nimbalyst for structured planning and task tracking.

### Custom Commands
- \`/track [type] [description]\` - Track bugs, tasks, ideas, and decisions (see ${commandsLocation}/commands/track.md for details)
  - Types: \`bug\`, \`task\`, \`idea\`, \`decision\`

### File Organization
- Plans are stored in \`${plansLocation}/\` as markdown files with YAML frontmatter
- Tracking items are stored in \`nimbalyst-local/tracker/\` organized by type (bugs.md, tasks.md, ideas.md, decisions.md)

For detailed documentation on tracking and templates, see the command files in ${commandsLocation}/commands/.`;
  }

  /**
   * Get example plan template
   */
  private getExamplePlanTemplate(): string {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    return `---
planStatus:
  planId: plan-example-feature
  title: Example Feature Plan
  status: draft
  planType: feature
  priority: medium
  owner: developer
  stakeholders:
    - developer
  tags:
    - example
    - getting-started
  created: "${today}"
  updated: "${now}"
  progress: 0
---

# Example Feature Plan

## Goals

This is an example plan document to help you get started with Nimbalyst's planning system.

Key objectives:
1. Demonstrate the plan document structure
2. Show how frontmatter metadata works
3. Provide a template for future plans

## Overview

Plans in Nimbalyst are markdown documents with YAML frontmatter that track features, bugs, and other development work. The frontmatter includes metadata like status, priority, and progress that powers the plan view interface.

## Implementation Details

When creating your own plans:

1. **Use the /design command**: Type \`/design [your feature description]\` in the AI chat to create a new plan with Claude Agent
2. **Choose descriptive filenames**: Use kebab-case names that clearly describe the plan
3. **Keep frontmatter updated**: Update status, progress, and updated timestamp as work progresses
4. **Write clear goals**: Start with clear, measurable objectives
5. **Include acceptance criteria**: Define what "done" means for this plan

## Next Steps

- Create your first real plan using \`/design [description]\`
- View all plans in the plan view (accessible from the View menu)
- Update this example plan's status as you learn the system
- Explore the tracking system with \`/track [type] [description]\`

## Acceptance Criteria

- [ ] Understand plan document structure
- [ ] Know how to create new plans
- [ ] Can update plan status and progress
- [ ] Comfortable with the plan view interface`;
  }

  /**
   * Enable analytics
   */
  async enableAnalytics(workspacePath: string): Promise<void> {
    const config = this.currentConfig || (await this.loadConfig(workspacePath));
    config.features.analytics = true;
    await this.saveConfig(workspacePath, config);
  }

  /**
   * Get current configuration
   */
  getCurrentConfig(): OnboardingConfig | null {
    return this.currentConfig;
  }

  /**
   * Check if any commands need to be installed
   * Returns true if at least one command is missing and user hasn't dismissed the toast
   */
  async needsCommandInstallation(workspacePath: string): Promise<boolean> {
    // Skip in Playwright tests
    if (window.PLAYWRIGHT || (window as any).PLAYWRIGHT) {
      return false;
    }

    try {
      const config = await this.loadConfig(workspacePath);

      // If user has dismissed the toast, don't show it again
      if (config.commandInstallToastDismissed) {
        return false;
      }

      const isGlobal = config.commandsLocation === 'global';

      // Check if any command is missing
      const commands = ['track.md', 'track-bug.md', 'track-idea.md', 'mockup.md'];

      for (const command of commands) {
        const relativePath = `commands/${command}`;
        try {
          if (isGlobal) {
            const result = await window.electronAPI.invoke('read-global-claude-file', relativePath);
            if (!result || !result.success) {
              return true; // Command is missing
            }
          } else {
            const existing = await window.electronAPI.readFileContent(`${workspacePath}/.claude/commands/${command}`);
            if (!existing || !existing.success) {
              return true; // Command is missing
            }
          }
        } catch (err) {
          // File doesn't exist
          return true;
        }
      }

      return false; // All commands installed
    } catch (error) {
      console.error('Failed to check command installation status:', error);
      return false;
    }
  }

  /**
   * Check if the nimbalyst-local directory exists
   */
  private async nimbalystLocalExists(workspacePath: string): Promise<boolean> {
    try {
      const result = await window.electronAPI.invoke('file:exists', `${workspacePath}/nimbalyst-local`);
      return !!result;
    } catch (error) {
      console.log('[OnboardingService] Could not check if nimbalyst-local exists:', error);
      return false;
    }
  }

  /**
   * Check if nimbalyst-local is already in .gitignore
   */
  private async isNimbalystLocalInGitignore(workspacePath: string): Promise<boolean> {
    try {
      const gitignorePath = `${workspacePath}/.gitignore`;
      const result = await window.electronAPI.readFileContent(gitignorePath);
      if (result && result.success) {
        return result.content.includes('nimbalyst-local/');
      }
      return false;
    } catch (error) {
      // .gitignore doesn't exist
      return false;
    }
  }

  /**
   * Ensure nimbalyst-local directory exists and is in .gitignore (if first time creation)
   * This is called when installing commands that use nimbalyst-local
   */
  private async ensureNimbalystLocalDir(workspacePath: string): Promise<void> {
    const dirExists = await this.nimbalystLocalExists(workspacePath);
    const alreadyIgnored = await this.isNimbalystLocalInGitignore(workspacePath);

    if (!dirExists) {
      // First time creation - create directory and add to .gitignore
      await this.ensurePlansDirectory(workspacePath);

      if (!alreadyIgnored) {
        await this.configureGitignore(workspacePath, 'nimbalyst-local');
      }
    }
    // If directory already exists, don't touch .gitignore
  }

  /**
   * Install all commands at once
   */
  async installAllCommands(workspacePath: string): Promise<void> {
    // Ensure nimbalyst-local directory exists before installing commands that use it
    await this.ensureNimbalystLocalDir(workspacePath);

    // Install each command - they already skip if already installed
    await this.installTrackCommand(workspacePath);
    await this.installTrackBugCommand(workspacePath);
    await this.installTrackIdeaCommand(workspacePath);
    await this.installMockupCommand(workspacePath);
  }

  /**
   * Mark that user has dismissed the commands install toast
   */
  async dismissCommandInstallToast(workspacePath: string): Promise<void> {
    const config = this.currentConfig || (await this.loadConfig(workspacePath));
    config.commandInstallToastDismissed = true;
    await this.saveConfig(workspacePath, config);
  }

  /**
   * Install /mockup command file
   */
  async installMockupCommand(workspacePath: string): Promise<void> {
    const config = this.currentConfig || await this.loadConfig(workspacePath);
    const isGlobal = config.commandsLocation === 'global';
    const relativePath = 'commands/mockup.md';

    try {
      // Check if mockup.md already exists
      try {
        if (isGlobal) {
          const result = await window.electronAPI.invoke('read-global-claude-file', relativePath);
          if (result && result.success) {
            console.log('mockup.md already exists in ~/.claude/, skipping installation');
            return;
          }
        } else {
          const existing = await window.electronAPI.readFileContent(`${workspacePath}/.claude/commands/mockup.md`);
          if (existing && existing.success) {
            console.log('mockup.md already exists in project .claude/, skipping installation');
            return;
          }
        }
      } catch (err) {
        // File doesn't exist, continue with installation
      }

      // Write mockup command template
      const template = this.getMockupCommandTemplate();
      if (isGlobal) {
        await window.electronAPI.invoke('write-global-claude-file', relativePath, template);
      } else {
        await window.electronAPI.invoke('create-document', `.claude/${relativePath}`, template);
      }

      // Update config
      if (this.currentConfig) {
        this.currentConfig.claudeCodeIntegration.mockupCommandInstalled = true;
        await this.saveConfig(workspacePath, this.currentConfig);
      }
    } catch (error) {
      console.error('Failed to install mockup command:', error);
      throw error;
    }
  }

  /**
   * Get mockup command template
   */
  private getMockupCommandTemplate(): string {
    return `Create a visual UX mockup for: {{arg1}}

## Determine Mockup Type

First, determine if this is:
1. **New screen/feature** - Something that doesn't exist yet
2. **Modification to existing screen** - Changes to an existing UI in the codebase

## Steps for NEW Screens

1. **Parse the request** - Understand what UI/screen/feature the user wants to mock up

2. **Check for style guide** - Look for \`nimbalyst-local/existing-screens/style-guide.mockup.html\`
   - **If style guide DOES NOT EXIST**:
     - Use the Task tool to spawn a sub-agent that will:
       - Explore the codebase to understand the app's look and feel
       - Find the theme files, CSS variables, color palette, and typography
       - Identify common UI patterns, component styles, and spacing conventions
       - Create \`nimbalyst-local/existing-screens/style-guide.mockup.html\` - a comprehensive visual reference showing:
         - Color palette (primary, secondary, accent colors, grays, semantic colors like error/success/warning)
         - Typography scale (headings H1-H6, body text, captions, with actual font families, sizes, weights, line heights)
         - Spacing scale (common padding/margin values used in the app)
         - Button styles (primary, secondary, danger, disabled states)
         - Form elements (inputs, textareas, selects, checkboxes, radio buttons)
         - Common UI patterns (cards, modals, tooltips, navigation elements)
         - Border radii and shadows
         - The style guide should be visually organized and easy to reference, like a design system documentation page
       - This should be a DEEP inspection of the existing UI and a comprehensive guide.
   - **If style guide EXISTS**:
     - Read it to understand the app's design system

3. **Create mockup file** - Create \`nimbalyst-local/mockups/[descriptive-name].mockup.html\`

4. **Build the mockup** - Write HTML with inline CSS that matches the style guide, ensuring consistency with the existing app

5. **Verify visually** - Use the Task tool to spawn a sub-agent that will:
   - Capture screenshot with \`mcp__nimbalyst__capture_editor_screenshot\`
   - Analyze for layout issues or problems
   - Fix with Edit tool if needed
   - Re-capture and iterate until correct

### Design Principles (New Screens)

**CRITICAL: New screen mockups should look realistic and consistent with the existing app.**

- **Match app styling**: Use the actual colors, fonts, and spacing from the codebase
- **Realistic appearance**: Mockups should look like finished UI, not sketches
- **Clear hierarchy**: Use size and spacing to show importance
- **Consistent patterns**: Follow the same component patterns used elsewhere in the app

## Steps for MODIFYING Existing Screens

### Directory Structure

- \`nimbalyst-local/existing-screens/\` - Cached replicas of existing UI screens
- \`nimbalyst-local/mockups/\` - Modified copies showing proposed changes

### Workflow

1. **Identify the screen** - Determine which existing screen/component is being modified

2. **Check for cached replica** - Look in \`nimbalyst-local/existing-screens/\` for \`[screen-name].mockup.html\`

3. **If cached replica EXISTS**:
   - Use the Task tool to spawn a sub-agent that will:
     - Check \`git log\` and \`git diff\` for changes to the relevant source files since the cached replica was last modified
     - If source files have changed, update the cached replica to match current implementation
     - If no changes, the cached replica is up-to-date
   - **No styling analysis needed** - The replica already contains all the styling information from the existing screen

4. **If cached replica DOES NOT EXIST**:
   - **Try to get a live screenshot first**:
     - If you have the ability to run the app and capture a screenshot automatically, do so - this gives the most accurate reference
     - If you cannot run the app, ask the user: "Would you like to provide a screenshot of the current screen? This will help me create a pixel-perfect replica. Otherwise, I'll recreate it from the source code."
   - **Deep code analysis** - Use the Task tool to spawn a sub-agent that will analyze the specific screen being replicated:
     - Find ALL relevant React components, CSS files, theme files, and related code **for this specific screen**
     - Extract exact colors (hex values), font sizes, font weights, line heights **used in this screen**
     - Document exact spacing values (padding, margin, gap) **in this screen**
     - Identify border radii, shadows, and other visual details **specific to this screen**
     - Spawn additional sub-agents if needed to cover different aspects (layout, typography, colors, icons)
     - If a screenshot was provided, use it as the reference to match pixel-for-pixel
     - **Note**: This is screen-specific analysis, not app-wide styling research
   - Create \`nimbalyst-local/existing-screens/[screen-name].mockup.html\` - a **pixel-perfect** HTML/CSS replica including:
     - Exact colors from the existing CSS
     - Exact typography (font family, size, weight, line height)
     - Exact spacing and dimensions
     - All visual details (shadows, borders, hover states if relevant)
   - Verify the replica visually with screenshot capture - iterate until it matches the original exactly

5. **Copy to mockups** - Copy the existing-screen replica to \`nimbalyst-local/mockups/[descriptive-name].mockup.html\`

6. **Apply modifications** - Edit the copy in mockups to include the proposed changes, keeping modifications **in full color**

7. **Verify visually** - Use the Task tool to spawn a sub-agent to capture and verify the mockup

8. **If the replica was updated or created and you were not able to obtain a screenshot**, after creating the replica, prompt the user in bold: **If you are able to give me a screenshot of the existing screen I can improve the mockup**

### Design Principles (Modifications)

**CRITICAL: Modifications to existing screens should be in FULL COLOR to show realistic integration.**

- **Match existing styles**: Use the actual colors, fonts, and spacing from the codebase
- **Highlight changes**: Consider using a subtle indicator (like a colored border or label) to show what's new/changed
- **Maintain consistency**: The mockup should look like it belongs in the existing app
- **Never modify existing-screens directly**: Always copy to mockups first, then modify the copy

## File Naming

- Use kebab-case: \`settings-page.mockup.html\`, \`checkout-flow.mockup.html\`
- Always use \`.mockup.html\` extension

## HTML Structure

Use standalone HTML with inline CSS. No external dependencies.

## User Annotations

The user can draw on mockups (circles, arrows, highlights). These annotations are **NOT** in the HTML source - you can only see them by capturing a screenshot with \`mcp__nimbalyst__capture_editor_screenshot\`.

When the user draws annotations:
1. Capture a screenshot to see what they marked
2. Interpret their feedback
3. Update the mockup accordingly

## Error Handling

- **No description provided**: Ask the user what they want to mock up
- **Ambiguous request**: Ask clarifying questions about scope, layout, or specific components
- **Can't find existing screen**: Ask the user to clarify which screen they mean, or offer to create a new mockup instead
- **Complex multi-screen flow**: Offer to create separate mockup files for each screen

## Important Notes

- **All mockups should look realistic** - Full color, proper styling, consistent with the app
- **New screens**: Research app styling first, then build consistent mockups
- **Modifications**: Create pixel-perfect replicas of existing screens, then modify
- Focus on communicating the concept clearly
- Include enough detail to make decisions, but no more
`;
  }
}

export default OnboardingService.getInstance();
