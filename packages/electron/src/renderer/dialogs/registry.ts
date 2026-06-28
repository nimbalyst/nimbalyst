/**
 * Dialog Registry
 *
 * This file registers all dialogs with the DialogProvider.
 * Import this file early in the app initialization to ensure
 * all dialogs are registered before they might be opened.
 */

import { registerDialog } from '../contexts/DialogContext';

// Navigation dialogs - mutually exclusive
export const DIALOG_IDS = {
  // Navigation group: one tabbed dialog combines Files, In Files, Sessions,
  // Prompts, and Projects. Opened with an initialTab (defaults to Files).
  UNIFIED_QUICK_OPEN: 'unified-quick-open',

  // Help group
  KEYBOARD_SHORTCUTS: 'keyboard-shortcuts',

  // Settings group
  API_KEY: 'api-key',

  // Alert group
  CONFIRM: 'confirm-dialog',
  ERROR: 'error-dialog',
  REWIND_SESSION: 'rewind-session',

  // System group
  PROJECT_SELECTION: 'project-selection',

  // Promotion group
  DISCORD_INVITATION: 'discord-invitation',

  // Feedback group
  FEEDBACK_INTAKE: 'feedback-intake',

  // Onboarding group
  ONBOARDING: 'onboarding',
  FEATURE_WALKTHROUGH: 'feature-walkthrough',
  WINDOWS_CLAUDE_CODE_WARNING: 'windows-claude-code-warning',
  ROSETTA_WARNING: 'rosetta-warning',
  EXTENSION_PROJECT_INTRO: 'extension-project-intro',

  // Developer group
  SESSION_IMPORT: 'session-import',

  // Creation group
  BLITZ_CREATE: 'blitz-create',

  // Share group
  SHARE: 'share',

  // Collaboration group
  CREATE_TEAM: 'create-team',
  SHARE_TO_TEAM: 'share-to-team',
} as const;

export type DialogId = (typeof DIALOG_IDS)[keyof typeof DIALOG_IDS];

/**
 * Initialize the dialog registry with all dialog configurations.
 * This must be called after the dialog components are imported.
 *
 * Note: We use dynamic imports or lazy loading to avoid circular dependencies.
 * The actual component registration happens in the individual dialog adapter files.
 */
export function initializeDialogRegistry() {
  // This function is a placeholder for initialization logic.
  // The actual registration happens when the adapter modules are imported.
  // This is called from App.tsx or the main entry point.
}
