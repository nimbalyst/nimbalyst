/**
 * Type definitions for the Contextual Tips System
 *
 * Tips are small, dismissible compact cards that appear in the bottom-left
 * corner based on user state and behavior. They share persistence with
 * the walkthrough system (same IPC channels and store).
 */

import type { ContentMode } from '../types/WindowModeTypes';
import type { FeatureUsageRecord } from '../../shared/featureUsage';

export type { ContentMode };

export type TipScreen = ContentMode | 'files-empty';

export interface TipTriggerContext {
  currentMode: ContentMode;
  workspacePath?: string;
  isGitRepo: boolean;
  isWorktreesAvailable: boolean;
  featureUsage: Record<string, FeatureUsageRecord>;
  hasBeenUsed: (feature: string) => boolean;
  hasReachedCount: (feature: string, threshold: number) => boolean;
  /**
   * Rolled-up per-tool usage. Keys are built-in tool names (`Bash`, `Read`) or
   * `mcp:<server>` for MCP/extension tools (e.g. `mcp:nimbalyst-excalidraw`).
   */
  toolUsage: Record<string, FeatureUsageRecord>;
  /** True when the given rolled-up tool key has been used at least once. */
  hasUsedTool: (toolKey: string) => boolean;
  /** Lifetime use count for a rolled-up tool key. */
  toolUseCount: (toolKey: string) => number;
}

/**
 * Trigger conditions for when to show a tip
 */
export interface TipTrigger {
  /** Screen/mode(s) that must be active, or '*' for any content mode */
  screen?: TipScreen | '*' | readonly (TipScreen | '*')[];
  /** Custom predicate - return true when tip should show */
  condition: (context: TipTriggerContext) => boolean;
  /** Delay (ms) after conditions are met before showing. Default: 2000 */
  delay?: number;
  /** Priority for deconfliction. Higher = higher priority. Default: 0 */
  priority?: number;
}

/**
 * Action button for a tip card
 */
export interface TipAction {
  /** Button label */
  label: string;
  /** What happens on click. Optional when `insertPrompt` is the action. */
  onClick?: () => void;
  /**
   * Text to insert into a composer when clicked (e.g. a slash command like
   * '/session-cleanup '). Only honored when the rendering surface provides an
   * insertion handler; the button is hidden otherwise. Runs before `onClick`.
   */
  insertPrompt?: string;
  /** Style variant */
  variant?: 'primary' | 'secondary' | 'link';
}

/**
 * Tip content displayed in the card
 */
export interface TipContent {
  /** SVG icon rendered in the card header (raw SVG path content) */
  icon?: React.ReactNode;
  /** Short title */
  title: string;
  /** Body text (supports basic markdown: **bold**) */
  body: string;
  /** Primary action button */
  action?: TipAction;
  /** Secondary link/navigation action */
  secondaryAction?: TipAction;
}

/**
 * Complete tip definition
 */
export interface TipDefinition {
  /** Unique identifier (prefix with 'tip-' to avoid collision with walkthrough IDs) */
  id: string;
  /** Human-readable name for analytics */
  name: string;
  /** Version number - bump to re-show to users who dismissed an older version */
  version?: number;
  /** Trigger conditions */
  trigger: TipTrigger;
  /** Tip content */
  content: TipContent;
}
