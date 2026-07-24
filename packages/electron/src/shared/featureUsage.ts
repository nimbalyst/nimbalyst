/**
 * Shared feature-usage types and well-known keys.
 *
 * Keep this file renderer-safe. Main-process persistence lives in
 * FeatureUsageService, but renderer code can import these constants when it
 * needs to query or record local usage state.
 */

export interface FeatureUsageRecord {
  count: number;
  firstUsed: string;
  lastUsed: string;
}

export const FEATURE_USAGE_KEYS = {
  SESSION_CREATED: 'session_created',
  SESSION_COMPLETED: 'session_completed',
  SESSION_COMPLETED_WITH_TOOLS: 'session_completed_with_tools',
  APP_LAUNCH: 'app_launch',
  AI_PROMPT_SUBMITTED: 'ai_prompt_submitted',
  EXCALIDRAW_OPENED: 'excalidraw_opened',
  MOCKUP_OPENED: 'mockup_opened',
  SPREADSHEET_OPENED: 'spreadsheet_opened',
  DATAMODEL_OPENED: 'datamodel_opened',
  TRACKER_USED: 'tracker_used',
  THEME_CHANGED: 'theme_changed',
  KEYBOARD_SHORTCUT_USED: 'keyboard_shortcut_used',
  FILE_CREATED: 'file_created',
  WORKTREE_CREATED: 'worktree_created',
} as const;

export type FeatureUsageKey =
  (typeof FEATURE_USAGE_KEYS)[keyof typeof FEATURE_USAGE_KEYS];
