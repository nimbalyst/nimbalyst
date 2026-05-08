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

/**
 * Diff data for a file changed by a tool call.
 * SYNC: Keep in sync with ToolCallDiffResult in packages/electron/src/main/services/ToolCallMatcher.ts
 */
export interface ToolCallDiffResult {
  filePath: string;
  operation: string; // 'create' | 'edit' | 'delete' | 'bash'
  diffs: Array<{ oldString: string; newString: string }>; // empty for bash/unknown
  content?: string; // full content for create operations
  linesAdded?: number;
  linesRemoved?: number;
  debugInfo?: string; // how this file was linked to the tool call
}

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
  /** Optional: Fetch file diffs caused by this tool call */
  getToolCallDiffs?: (
    toolCallItemId: string,
    toolCallTimestamp?: number
  ) => Promise<ToolCallDiffResult[] | null>;
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
import { VisualDisplayWidget } from './VisualDisplayWidget';
import { BashWidget } from './BashWidget';
import { GitCommitConfirmationWidget } from './GitCommitConfirmationWidget';
import { ExitPlanModeWidget } from './ExitPlanModeWidget';
import { ToolPermissionWidget } from './ToolPermissionWidget';
import { SuperProgressSnapshotWidget } from './SuperProgressSnapshotWidget';
import { SuperLoopProgressWidget } from './SuperLoopProgressWidget';
import { UpdateSessionMetaWidget } from './UpdateSessionMetaWidget';
import { TrackerToolWidget } from './TrackerToolWidget';

/**
 * Registry of custom tool widgets
 *
 * Keys are tool names (as they appear in message.toolCall.toolName)
 * Values are React components that render the custom widget
 *
 * Note: MCP tools may have prefixed names (e.g., mcp__nimbalyst-mcp__capture_editor_screenshot)
 * Register both the base name and prefixed variants for full compatibility.
 */
export const CUSTOM_TOOL_WIDGETS: CustomToolWidgetRegistry = {
  // Editor screenshot capture tool (works for mockups and all other editor types)
  'capture_editor_screenshot': EditorScreenshotWidget,
  'mcp__nimbalyst-mcp__capture_editor_screenshot': EditorScreenshotWidget,

  // AskUserQuestion tool - displays questions from Claude for user input
  'AskUserQuestion': AskUserQuestionWidget,
  'mcp__nimbalyst__AskUserQuestion': AskUserQuestionWidget,
  'mcp__nimbalyst-mcp__AskUserQuestion': AskUserQuestionWidget,

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

/**
 * Get a custom widget component for a tool name, if one is registered
 *
 * This function handles MCP prefix stripping automatically:
 * - First checks for exact match
 * - Then strips 'mcp__nimbalyst__' prefix and checks again
 * - Then strips any 'mcp__*__' prefix pattern and checks again
 *
 * @param toolName The name of the tool from the message
 * @returns The custom widget component, or undefined if none registered
 */
export function getCustomToolWidget(toolName: string): CustomToolWidgetComponent | undefined {
  // Direct match
  if (CUSTOM_TOOL_WIDGETS[toolName]) {
    return CUSTOM_TOOL_WIDGETS[toolName];
  }

  // Strip nimbalyst MCP prefix
  const withoutNimbalystPrefix = toolName.replace(/^mcp__nimbalyst__/, '');
  if (withoutNimbalystPrefix !== toolName && CUSTOM_TOOL_WIDGETS[withoutNimbalystPrefix]) {
    return CUSTOM_TOOL_WIDGETS[withoutNimbalystPrefix];
  }

  // Strip any MCP prefix pattern (mcp__serverName__)
  const withoutAnyMcpPrefix = toolName.replace(/^mcp__[^_]+__/, '');
  if (withoutAnyMcpPrefix !== toolName && CUSTOM_TOOL_WIDGETS[withoutAnyMcpPrefix]) {
    return CUSTOM_TOOL_WIDGETS[withoutAnyMcpPrefix];
  }

  // Backward compatibility for shell commands that were persisted with the raw
  // wrapper command as the tool name instead of the normalized command_execution type.
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
