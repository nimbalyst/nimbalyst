/**
 * HelpContent - Centralized registry for UI help text
 *
 * This module provides a single source of truth for help content that appears
 * in walkthroughs, tooltips, and other help UI. By centralizing this content,
 * we ensure consistency and make it easy to update help text in one place.
 *
 * See nimbalyst-local/plans/help-content-inventory.md for the full inventory.
 */

import { KeyboardShortcuts } from '../../shared/KeyboardShortcuts';
import { getRegisteredPanels } from '../extensions/panels/PanelRegistry';
import { getRegisteredKeybindings } from '../extensions/commands/ExtensionCommandRegistry';

/**
 * Help content for a single UI element
 */
export interface HelpEntry {
  /** Short title for the feature */
  title: string;
  /** Longer description of what the feature does */
  body: string;
  /** Optional keyboard shortcut (from KeyboardShortcuts) */
  shortcut?: string;
}

/**
 * Central registry of help content, keyed by data-testid
 */
export const HelpContent: Record<string, HelpEntry> = {
  // ============================================================================
  // Teams - Security & encryption (Epic H2)
  // ============================================================================

  'h2-security-encryption-section': {
    title: 'Security & encryption',
    body: 'Controls how your team\'s shared data is encrypted. End-to-end encrypted teams (desktop & mobile only) can be migrated to server-managed keys to unlock web, CLI, and AI-agent access — encrypted, isolated per team, and audit-logged, but no longer zero-knowledge. Your personal sync always stays end-to-end encrypted. Only owners and admins can migrate.',
  },

  // ============================================================================
  // Files Mode - File Tree
  // ============================================================================

  'file-tree-filter-button': {
    title: 'Filter Your File Tree',
    body: 'Show only markdown files, uncommitted git changes, or files the AI has read or written in this session.',
  },
  'file-tree-quick-open-button': {
    title: 'Quick Open Files',
    body: 'Search for any file in your project by name. Recently opened files appear at the top.',
    shortcut: KeyboardShortcuts.file.open,
  },
  'file-tree-new-file-button': {
    title: 'New File',
    body: 'Create a new file in the selected folder.',
    shortcut: KeyboardShortcuts.file.newFile,
  },
  'file-tree-new-folder-button': {
    title: 'New Folder',
    body: 'Create a new folder in the selected folder.',
  },
  'file-tree-refresh-button': {
    title: 'Refresh File Tree',
    body: 'Reload the file list from disk to pick up files added or removed outside Nimbalyst.',
  },

  // ============================================================================
  // Files Mode - Unified Header
  // ============================================================================

  'ai-sessions-button': {
    title: 'Past AI Sessions',
    body: 'See AI sessions that edited this file. Jump back to continue a conversation or review changes.',
  },
  'file-history-button': {
    title: 'Document History',
    body: 'View previous versions of this document. Restore or compare any saved state.',
    shortcut: KeyboardShortcuts.edit.viewHistory,
  },
  'toc-toggle-button': {
    title: 'Table of Contents',
    body: 'Toggle the table of contents panel. Navigate quickly to any heading in the document.',
  },

  // ============================================================================
  // Files Mode - Diff Mode
  // ============================================================================

  'diff-keep-button': {
    title: 'Keep Changes',
    body: 'Accept the AI changes for this section and update the document.',
    shortcut: KeyboardShortcuts.edit.approve,
  },
  'diff-revert-button': {
    title: 'Revert Changes',
    body: 'Reject the AI changes and restore the original content.',
    shortcut: KeyboardShortcuts.edit.reject,
  },
  'diff-keep-all-button': {
    title: 'Keep All Changes',
    body: 'Accept all pending AI changes throughout the document.',
  },
  'diff-revert-all-button': {
    title: 'Revert All Changes',
    body: 'Reject all pending AI changes and restore the original document.',
  },

  // ============================================================================
  // Navigation
  // ============================================================================

  'nav-back-button': {
    title: 'Navigate Back',
    body: 'Go back to the previous file or location.',
    shortcut: KeyboardShortcuts.view.navigateBack,
  },
  'nav-forward-button': {
    title: 'Navigate Forward',
    body: 'Go forward in your navigation history.',
    shortcut: KeyboardShortcuts.view.navigateForward,
  },

  // ============================================================================
  // View Modes
  // ============================================================================

  'files-mode-button': {
    title: 'Files Mode',
    body: 'Browse and edit your project files with AI assistance on any document.',
    shortcut: KeyboardShortcuts.view.filesMode,
  },
  'agent-mode-button': {
    title: 'Agent Mode',
    body: 'Full AI coding agent with project-wide context, tool use, and multi-step tasks.',
    shortcut: KeyboardShortcuts.view.agentMode,
  },

  // ============================================================================
  // Agent Mode - Session Views
  // ============================================================================

  'session-kanban-button': {
    title: 'Kanban Board',
    body: 'Switch to a kanban board view of your sessions organized by phase: Backlog, Planning, Implementing, Validating, and Complete. Drag sessions between columns to update their status.',
    shortcut: KeyboardShortcuts.window.kanbanView,
  },

  // ============================================================================
  // Agent Mode - Layout Controls
  // ============================================================================

  'layout-controls': {
    title: 'Session Layout Modes',
    body: `View your AI session and files edited together:

**Files**: Show only the file editor tabs. Available when you open an edited file in an AI Session.

**Split**: Show both transcript and editor stacked vertically. Drag the divider to adjust.

**Agent**: Show only the conversation transcript.`,
  },

  // ============================================================================
  // Agent Mode - Session Management
  // ============================================================================

  'session-history-button': {
    title: 'Session History',
    body: 'Browse past AI sessions. Search, filter, and resume previous conversations.',
    shortcut: KeyboardShortcuts.window.sessionManager,
  },
  'session-quick-open-button': {
    title: 'Quick Open Session',
    body: 'Search and jump to any AI session by content or title. Much faster than scrolling through history.',
    shortcut: KeyboardShortcuts.window.sessionQuickOpen,
  },
  'session-quick-search-button': {
    title: 'Search Sessions',
    body: `Quickly find any AI session by name. Type **@** to search by file edited -- find every session that touched a specific file. Press **Tab** to switch to prompt search and find sessions by what you asked.`,
    shortcut: KeyboardShortcuts.window.sessionQuickOpen,
  },
  'session-archive-button': {
    title: 'Archive Session',
    body: 'Archive this session to keep your session list organized. Archived sessions can be restored anytime.',
  },

  'tracker-automation-section': {
    title: 'Tracker Automation',
    body: `Automatically connect git commits to your tracker items. When enabled, Nimbalyst links commits via the session's tracker items and by parsing issue keys (e.g. **NIM-123**) from commit messages — including commits made in your terminal.\n\nFor project-specific behavior, add instructions to your project's **CLAUDE.md** (e.g. "always reference tracker issue keys in commits" or "don't auto-close critical bugs without review").`,
  },

  // ============================================================================
  // Agent Mode - AI Input
  // ============================================================================

  'agent-input': {
    title: 'AI Input',
    body: 'Type your message or paste images and files. The AI has full context of your project.',
  },
  'plan-mode-toggle': {
    title: 'Plan vs Agent Mode',
    body: 'Toggle between Plan and Agent modes. Plan mode creates structured plans before the AI writes code. Agent mode executes changes directly.',
  },
  'attach-files-input': {
    title: 'Attach Files & Images',
    body: 'Drag and drop files or paste images directly into the chat. You can also use @ to mention files from your project.',
  },
  'agent-welcome': {
    title: 'Start Your First Session',
    body: 'Create an AI coding session. Describe what you want to build, and the agent will help you.',
  },

  // ============================================================================
  // Agent Mode - Files Edited Sidebar
  // ============================================================================

  'files-scope-dropdown': {
    title: 'File Scope Modes',
    body: 'Control which files are shown. View AI edits from this session, only uncommitted changes, or all files in the workspace. In workstreams, filter by individual session or see all sessions combined.',
  },

  // ============================================================================
  // Agent Mode - Git Operations
  // ============================================================================

  'git-commit-mode-toggle': {
    title: 'Commit Modes',
    body: 'Choose how to commit your changes. Manual lets you write your own message. Smart uses AI to analyze changes and propose a commit message.',
  },
  'git-operations-commit-with-ai-button': {
    title: 'AI-Assisted Commit',
    body: 'Have the AI analyze your changes and propose a set of files and a commit message for you to edit and approve.',
  },

  // ============================================================================
  // Agent Mode - Model & Context
  // ============================================================================

  'model-picker': {
    title: 'Select AI Model',
    body: 'Choose which AI model to use. Different models have different capabilities and speeds.',
  },
  'model-picker-provider-claude-code': {
    title: 'Claude Agent (Claude Code Based)',
    body: 'The in-app agent built on Claude Code with full Nimbalyst integration: it sees your active document and selection, renders the rich inline transcript, and tracks every file it edits. Uses your configured Anthropic API key.',
  },
  'model-picker-provider-claude-code-cli': {
    title: 'Claude Code CLI (Terminal Mode)',
    body: 'Runs the genuine claude terminal binary in an embedded terminal, billed to your Claude subscription. You get native CLI behavior — its slash commands and TUI — in the Raw terminal drawer, while Nimbalyst mirrors the conversation into the rich transcript.',
  },
  'action-prompts-dropdown': {
    title: 'Action Prompts',
    body: 'Reusable prompts you define in nimbalyst-local/ai-actions.md. Picking one inserts its body into the draft so you can tweak it before sending.',
  },
  'context-indicator': {
    title: 'Context Window',
    body: 'Shows how much of the AI context window is used. Includes files, conversation history, and tools.',
  },

  // ============================================================================
  // Agent Mode - Transcript Controls
  // ============================================================================

  'transcript-archive-button': {
    title: 'Archive Session',
    body: 'Archive this session to keep your session list tidy.',
  },
  'transcript-search-button': {
    title: 'Search Transcript',
    body: 'Search within this conversation for specific messages or content.',
  },

  // ============================================================================
  // Agent Mode - Voice
  // ============================================================================

  'voice-mode-toggle': {
    title: 'Voice Mode',
    body: 'Speak to the AI instead of typing. The AI will respond with voice.',
  },

  // ============================================================================
  // Project Window Gutter
  // ============================================================================

  'gutter-permissions-button': {
    title: 'Agent Permissions',
    body: 'Configure which tools the AI agent can use. Control file access, command execution, and more.',
  },
  'gutter-sync-button': {
    title: 'Session Sync',
    body: 'Check sync status for this project and manage sync settings.',
  },
  'gutter-extension-dev-button': {
    title: 'Extension Dev Mode',
    body: 'Open extension development tools, logs, and rebuild options.',
  },
  'gutter-theme-button': {
    title: 'Theme',
    body: 'Switch between light and dark themes.',
  },
  'gutter-feedback-button': {
    title: 'Send Feedback',
    body: 'Share feedback or report issues with the team.',
  },
  'gutter-user-button': {
    title: 'User Menu',
    body: 'Open user menu to access User Settings, Project Settings, Team Settings, and account info.',
  },
  'terminal-panel-button': {
    title: 'Terminal',
    body: 'Toggle the terminal panel for running commands.',
    shortcut: KeyboardShortcuts.view.toggleTerminalPanel,
  },
  'tracker-mode-button': {
    title: 'Trackers',
    body: 'Switch to Tracker mode for a full project management view with table and kanban layouts.',
    shortcut: KeyboardShortcuts.view.trackerMode,
  },
  'collab-mode-button': {
    title: 'Shared Documents',
    body: 'Browse and edit documents shared with your team in real-time. Collaborate on markdown, spreadsheets, and diagrams.',
    shortcut: KeyboardShortcuts.view.collabMode,
  },
  'pr-review-mode-button': {
    title: 'Pull Requests',
    body: 'Review GitHub pull requests without leaving the app: browse the list, read diffs and conversation, and approve or merge.',
    shortcut: KeyboardShortcuts.view.prReviewMode,
  },

  // ============================================================================
  // Settings
  // ============================================================================

  'settings-project-tab': {
    title: 'Project Settings',
    body: 'Settings specific to this project. Stored in the project folder.',
  },
  'settings-global-tab': {
    title: 'Global Settings',
    body: 'Settings that apply to all projects.',
  },
  'settings-walkthroughs-toggle': {
    title: 'Feature Guides',
    body: 'Show helpful guides for new features. Guides appear automatically as you use the app.',
  },
  'settings-walkthroughs-reset': {
    title: 'Reset Guides',
    body: 'Show all feature guides again, even ones you have already seen.',
  },

  // ============================================================================
  // Project Manager
  // ============================================================================

  'project-manager-open': {
    title: 'Open Project',
    body: 'Open a project folder from your computer.',
    shortcut: KeyboardShortcuts.file.openFolder,
  },
  'project-manager-recent': {
    title: 'Recent Projects',
    body: 'Your recently opened projects for quick access.',
  },
};

/**
 * Get help content for a UI element by its data-testid.
 * Checks the static registry first, then falls back to extension panel tooltips.
 */
export function getHelpContent(testId: string): HelpEntry | undefined {
  if (testId in HelpContent) {
    return HelpContent[testId];
  }
  return getExtensionPanelHelpContent(testId);
}

/**
 * Check if help content exists for a given testId
 */
export function hasHelpContent(testId: string): boolean {
  if (testId in HelpContent) return true;
  return getExtensionPanelHelpContent(testId) !== undefined;
}

/**
 * Dynamically look up help content from extension panel tooltips.
 * Extension gutter buttons use the testId pattern:
 *   "extension-bottom-panel-{panelId}"
 *   "extension-panel-{panelId}"
 *
 * The tooltip field in the panel manifest contribution populates this.
 */
function getExtensionPanelHelpContent(testId: string): HelpEntry | undefined {
  // Match gutter button testId patterns for extension panels
  const panelIdFromTestId = testId.startsWith('extension-bottom-panel-')
    ? testId.slice('extension-bottom-panel-'.length)
    : testId.startsWith('extension-panel-')
    ? testId.slice('extension-panel-'.length)
    : null;

  if (!panelIdFromTestId) return undefined;

  const panels = getRegisteredPanels();
  const panel = panels.find(p => p.id === panelIdFromTestId);
  if (!panel?.tooltip) return undefined;

  // Find the keybinding bound to this panel's toggle command
  const keybindings = getRegisteredKeybindings();
  const kb = keybindings.find(k => k.commandId === `${panel.id}.toggle`);

  return {
    title: panel.title,
    body: panel.tooltip,
    shortcut: kb?.key,
  };
}
