/**
 * Custom Tool Widget Registry
 *
 * This module provides a framework for registering custom widgets that replace
 * the default tool call rendering in the AI transcript view.
 *
 * ## How to add a new custom tool widget:
 *
 * 1. Create a new widget component in this folder (e.g., MyToolWidget.tsx)
 *    - The component should accept CustomToolWidgetProps
 *    - Export the component
 *
 * 2. Register the widget in this file:
 *    - Import the component
 *    - Add an entry to CUSTOM_TOOL_WIDGETS mapping tool name to component
 *
 * ## Example:
 *
 * ```typescript
 * // In MyToolWidget.tsx
 * import React from 'react';
 * import type { CustomToolWidgetProps } from './index';
 *
 * export const MyToolWidget: React.FC<CustomToolWidgetProps> = ({ message, isExpanded, onToggle }) => {
 *   const tool = message.toolCall!;
 *   // Render your custom UI
 *   return <div>...</div>;
 * };
 *
 * // In index.ts
 * import { MyToolWidget } from './MyToolWidget';
 *
 * export const CUSTOM_TOOL_WIDGETS: CustomToolWidgetRegistry = {
 *   'my_tool_name': MyToolWidget,
 *   // MCP tools are often prefixed - register both variants
 *   'mcp__nimbalyst__my_tool_name': MyToolWidget,
 * };
 * ```
 */

import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';

// Re-export widgets
export { EditorScreenshotWidget, MockupScreenshotWidget } from './EditorScreenshotWidget';
export { AskUserQuestionWidget } from './AskUserQuestionWidget';
export { RequestUserInputWidget } from './RequestUserInputWidget';
export { VisualDisplayWidget } from './VisualDisplayWidget';
export { BashWidget } from './BashWidget';
export { GitCommitConfirmationWidget } from './GitCommitConfirmationWidget';
export { ExitPlanModeWidget } from './ExitPlanModeWidget';
export { ToolPermissionWidget } from './ToolPermissionWidget';
export { FileChangeWidget } from './FileChangeWidget';
export { SuperProgressSnapshotWidget } from './SuperProgressSnapshotWidget';
export { SuperLoopProgressWidget } from './SuperLoopProgressWidget';
export { UpdateSessionMetaWidget } from './UpdateSessionMetaWidget';
export { TrackerToolWidget } from './TrackerToolWidget';
export { ToolWidgetErrorBoundary } from './ToolWidgetErrorBoundary';

// Re-export host types (for use in SessionTranscript to set the host)
export type { InteractiveWidgetHost, PermissionScope, ToolPermissionResponse } from './InteractiveWidgetHost';
export { noopInteractiveWidgetHost } from './InteractiveWidgetHost';

export type { ToolCallDiffResult } from '../../../../ai/server/transcript/TranscriptProjector';

/**
 * Props passed to custom tool widgets
 */
export interface CustomToolWidgetProps {
  /** The message containing the tool call */
  message: TranscriptViewMessage;
  /** Whether the widget is expanded (for collapsible widgets) */
  isExpanded: boolean;
  /** Toggle expand/collapse state */
  onToggle: () => void;
  /** Workspace path for resolving relative paths */
  workspacePath?: string;
  /** Session ID this widget belongs to - required for session-scoped state */
  sessionId: string;
  /** Optional: Read a file from the filesystem (for loading persisted output files) */
  readFile?: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  // Note: Interactive widgets read their host from interactiveWidgetHostAtom(sessionId)
  // No host prop needed - avoids prop drilling through the component tree
}

/**
 * A React component that renders a custom tool widget
 */
export type CustomToolWidgetComponent = React.FC<CustomToolWidgetProps>;

/**
 * Registry mapping tool names to custom widget components
 */
export type CustomToolWidgetRegistry = Record<string, CustomToolWidgetComponent>;

const SHELL_WRAPPER_NAME_REGEX = /^(?:\/(?:bin|usr\/bin)\/)?(?:bash|zsh|sh)\s+-l?c\s+[\s\S]+$/;
const WINDOWS_SHELL_NAME_REGEX = /^(?:"?[A-Za-z]:\\[^"]*\\)?(?:powershell|pwsh|cmd)(?:\.exe)?"?\s+(?:-Command|\/[cC])\s+[\s\S]+$/i;

// Import custom widgets
import { EditorScreenshotWidget } from './EditorScreenshotWidget';
import { AskUserQuestionWidget } from './AskUserQuestionWidget';
import { RequestUserInputWidget } from './RequestUserInputWidget';
import { VisualDisplayWidget } from './VisualDisplayWidget';
import { BashWidget } from './BashWidget';
import { GitCommitConfirmationWidget } from './GitCommitConfirmationWidget';
import { ExitPlanModeWidget } from './ExitPlanModeWidget';
import { ToolPermissionWidget } from './ToolPermissionWidget';
import { SuperProgressSnapshotWidget } from './SuperProgressSnapshotWidget';
import { SuperLoopProgressWidget } from './SuperLoopProgressWidget';
import { UpdateSessionMetaWidget } from './UpdateSessionMetaWidget';
import { TrackerToolWidget } from './TrackerToolWidget';

import {
  getTranscriptToolWidget,
  setTranscriptToolWidgets,
} from '../../contributions/TranscriptToolWidgetContributions';

/**
 * Built-in custom tool widget registrations.
 *
 * These widgets render the host-shipped tool calls (Bash, AskUserQuestion,
 * commit proposal, etc.). They are registered to the shared transcript
 * widget registry at module load so extension-contributed widgets and
 * built-ins live in the same lookup path; see
 * `../../contributions/TranscriptToolWidgetContributions`.
 *
 * Keys are tool names (as they appear in message.toolCall.toolName).
 * MCP tools may have prefixed names (e.g.,
 * `mcp__nimbalyst-mcp__capture_editor_screenshot`); register both the bare
 * name and the prefixed variants when the legacy session log might contain
 * either.
 */
const BUILT_IN_TOOL_WIDGETS: CustomToolWidgetRegistry = {
  // Editor screenshot capture tool (works for mockups and all other editor types)
  'capture_editor_screenshot': EditorScreenshotWidget,
  'mcp__nimbalyst-mcp__capture_editor_screenshot': EditorScreenshotWidget,

  // AskUserQuestion tool - displays questions from Claude for user input
  'AskUserQuestion': AskUserQuestionWidget,
  'mcp__nimbalyst__AskUserQuestion': AskUserQuestionWidget,
  'mcp__nimbalyst-mcp__AskUserQuestion': AskUserQuestionWidget,

  // PromptForUserInput tool - generic structured-input prompt with typed fields
  // (multiSelect, singleSelect, reorder, editText, confirm).
  // The wire-name is `PromptForUserInput` rather than `RequestUserInput` to
  // avoid colliding with Codex CLI's built-in `request_user_input` tool which
  // is gated to Plan mode (snake_case match).
  'PromptForUserInput': RequestUserInputWidget,
  'mcp__nimbalyst__PromptForUserInput': RequestUserInputWidget,
  'mcp__nimbalyst-mcp__PromptForUserInput': RequestUserInputWidget,
  // Back-compat: any historical sessions that recorded the old name still render.
  'RequestUserInput': RequestUserInputWidget,
  'mcp__nimbalyst__RequestUserInput': RequestUserInputWidget,
  'mcp__nimbalyst-mcp__RequestUserInput': RequestUserInputWidget,

  // ExitPlanMode tool - interactive confirmation widget for exiting planning mode
  'ExitPlanMode': ExitPlanModeWidget,

  // Display to user tool - renders charts and image galleries inline in the transcript
  'display_to_user': VisualDisplayWidget,
  'mcp__nimbalyst__display_to_user': VisualDisplayWidget,

  // Bash tool - terminal-style display for shell commands
  'Bash': BashWidget,
  'command_execution': BashWidget,

  // Git commit proposal tool - interactive commit confirmation widget
  'git_commit_proposal': GitCommitConfirmationWidget,
  'developer_git_commit_proposal': GitCommitConfirmationWidget,
  'developer.git_commit_proposal': GitCommitConfirmationWidget,
  'mcp__nimbalyst-mcp__developer_git_commit_proposal': GitCommitConfirmationWidget,
  'mcp__nimbalyst-extension-dev__developer_git_commit_proposal': GitCommitConfirmationWidget,

  // Tool permission - interactive permission widget for tools requiring approval
  'ToolPermission': ToolPermissionWidget,

  // Note: Codex `file_change` is intentionally NOT registered here. It is handled by
  // EditToolResultCard via the EDIT_TOOL_NAMES path in RichTranscriptView so it renders
  // as an inline red/green diff instead of the older snapshot-only widget.

  // Super Loop progress snapshot - shows progress.json at iteration start/end
  'SuperProgressSnapshot': SuperProgressSnapshotWidget,

  // Super Loop progress update tool - shows progress summary or blocked feedback UI
  'super_loop_progress_update': SuperLoopProgressWidget,
  'mcp__nimbalyst-super-loop-progress__super_loop_progress_update': SuperLoopProgressWidget,

  // Session metadata update tool - shows tag/phase/name transitions
  'update_session_meta': UpdateSessionMetaWidget,
  'mcp__nimbalyst-session-naming__update_session_meta': UpdateSessionMetaWidget,
  // Legacy tool names (pre-merge) - fallback rendering for old sessions
  'name_session': UpdateSessionMetaWidget,
  'mcp__nimbalyst-session-naming__name_session': UpdateSessionMetaWidget,
  'update_tags': UpdateSessionMetaWidget,
  'mcp__nimbalyst-session-naming__update_tags': UpdateSessionMetaWidget,

  // Tracker tools - list, get, create, update, link
  'tracker_list': TrackerToolWidget,
  'tracker_get': TrackerToolWidget,
  'tracker_create': TrackerToolWidget,
  'tracker_update': TrackerToolWidget,
  'tracker_link_session': TrackerToolWidget,
  'tracker_link_file': TrackerToolWidget,
};

// Identifier used when the host registers built-in widgets to the runtime
// registry. Kept stable so this module can replace or clear its own slot
// during dev reload without disturbing extension-contributed widgets.
const BUILT_IN_TRANSCRIPT_WIDGET_SOURCE = 'nimbalyst:transcript-core';

// Register built-ins once per module load. Extensions live alongside on the
// same registry and resolve through `getCustomToolWidget` below.
setTranscriptToolWidgets(BUILT_IN_TRANSCRIPT_WIDGET_SOURCE, BUILT_IN_TOOL_WIDGETS);

/**
 * Back-compat alias for the historical built-in widget map. Read-only.
 * New code should prefer `getCustomToolWidget` / `getTranscriptToolWidget`,
 * which see extension-contributed widgets as well.
 */
export const CUSTOM_TOOL_WIDGETS: CustomToolWidgetRegistry = BUILT_IN_TOOL_WIDGETS;

/**
 * Get a custom widget component for a tool name, if one is registered.
 *
 * Resolution order:
 *  1. Anything contributed via `setTranscriptToolWidgets` (including
 *     built-ins and extension contributions) using exact match.
 *  2. Same lookup with the `mcp__nimbalyst__` prefix stripped.
 *  3. Same lookup with any `mcp__<server>__` prefix stripped.
 *  4. Shell-wrapper fallback: if the tool name looks like a raw `bash -c`
 *     / `powershell -Command` invocation persisted from a historical
 *     session, render it with the bash widget.
 *
 * Steps 1-3 are delegated to the transcript widget registry so extensions
 * can override or add widgets; step 4 stays local because it is bash-only
 * back-compat tied to the regex constants in this file.
 *
 * @param toolName The name of the tool from the message
 * @returns The custom widget component, or undefined if none registered
 */
export function getCustomToolWidget(toolName: string): CustomToolWidgetComponent | undefined {
  const fromRegistry = getTranscriptToolWidget(toolName);
  if (fromRegistry) return fromRegistry;

  // Backward compatibility for shell commands that were persisted with the
  // raw wrapper command as the tool name instead of the normalized
  // command_execution type. Anchored to bash/zsh/sh/powershell/cmd
  // invocations; everything else falls through to the generic tool card.
  if (SHELL_WRAPPER_NAME_REGEX.test(toolName) || WINDOWS_SHELL_NAME_REGEX.test(toolName)) {
    return BashWidget;
  }

  return undefined;
}

/**
 * Check if a tool has a custom widget registered
 *
 * @param toolName The name of the tool from the message
 * @returns true if a custom widget is registered for this tool
 */
export function hasCustomToolWidget(toolName: string): boolean {
  return getCustomToolWidget(toolName) !== undefined;
}
