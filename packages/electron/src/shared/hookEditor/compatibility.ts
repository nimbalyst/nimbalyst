/**
 * Which hook types, matchers, "Narrow to" rules and Then answers each Claude
 * Code event takes. This is data, not code paths: the palette greying, the
 * drop slots and the reducer refusals all read this one table.
 *
 * Sources: research/2026-10-08-events-plugins-mods.md (sections 1A, 1B, 2)
 * and research/2026-10-08-block-catalog-gaps.md (Findings 1 to 3), both in
 * the local hooks-mods-manager folder, checked against SDK 0.3.293.
 */

import type { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';

import type { HookType, ThenAnswer } from './types';

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** What the "Only when" block offers for an event. */
export type MatcherRule =
  | { kind: 'none' }
  | { kind: 'toolName' }
  | { kind: 'values'; values: readonly string[] }
  | { kind: 'freeText'; examples: readonly string[] }
  | { kind: 'fileNames' };

export interface EventRule {
  /** The hook types Claude Code runs on this event. */
  hookTypes: readonly HookType[];
  /** What the "Only when" block offers. */
  matcher: MatcherRule;
  /** True when "Narrow to" (the `if` field) runs on this event. On other events a hook with `if` never runs. */
  ifRuns: boolean;
  /** The Then answers Claude Code acts on for this event. */
  thenAnswers: readonly ThenAnswer[];
  /** True when exit 2 blocks the action on this event. */
  exit2Blocks: boolean;
  /** The default "Gives up after" time, only when the event changes it. */
  defaultTimeoutSeconds?: number;
}

const ALL_FIVE: readonly HookType[] = ['command', 'http', 'mcp_tool', 'prompt', 'agent'];
const NO_AI: readonly HookType[] = ['command', 'http', 'mcp_tool'];
const NONE: MatcherRule = { kind: 'none' };
const TOOL: MatcherRule = { kind: 'toolName' };
const AGENT_TYPES: MatcherRule = { kind: 'freeText', examples: ['general-purpose', 'Explore', 'Plan'] };
const MODEL_NAMES: MatcherRule = { kind: 'freeText', examples: ['claude-opus-5', '.*opus.*'] };
const MCP_SERVERS: MatcherRule = { kind: 'freeText', examples: [] };
const COMPACT_TRIGGERS: MatcherRule = { kind: 'values', values: ['manual', 'auto'] };

export const EVENT_RULES: Readonly<Record<HookEventName, EventRule>> = {
  PreToolUse: {
    hookTypes: ALL_FIVE, matcher: TOOL, ifRuns: true,
    thenAnswers: ['permission', 'addContext', 'tellUser'], exit2Blocks: true,
  },
  PostToolUse: {
    hookTypes: ALL_FIVE, matcher: TOOL, ifRuns: true,
    thenAnswers: ['block', 'addContext', 'tellUser'], exit2Blocks: false,
  },
  PostToolUseFailure: {
    hookTypes: ALL_FIVE, matcher: TOOL, ifRuns: true,
    thenAnswers: ['block', 'addContext', 'tellUser'], exit2Blocks: false,
  },
  PostToolBatch: {
    hookTypes: ALL_FIVE, matcher: NONE, ifRuns: false,
    thenAnswers: ['block', 'addContext', 'stopClaude', 'tellUser'], exit2Blocks: true,
  },
  Notification: {
    hookTypes: NO_AI,
    // An open list: the SDK types the notification type as plain text.
    matcher: {
      kind: 'freeText',
      examples: [
        'permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'elicitation_url_dialog',
        'elicitation_complete', 'elicitation_response', 'agent_needs_input', 'agent_completed',
        'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
      ],
    },
    ifRuns: false, thenAnswers: [], exit2Blocks: false,
  },
  UserPromptSubmit: {
    hookTypes: ALL_FIVE, matcher: NONE, ifRuns: false,
    thenAnswers: ['block', 'addContext', 'tellUser'], exit2Blocks: true, defaultTimeoutSeconds: 30,
  },
  UserPromptExpansion: {
    hookTypes: ALL_FIVE, matcher: { kind: 'freeText', examples: [] }, ifRuns: false,
    thenAnswers: ['block', 'addContext', 'tellUser'], exit2Blocks: true,
  },
  SessionStart: {
    // Its mcp_tool hooks skip launch and resume. They run after /clear and after compaction.
    hookTypes: ['command', 'mcp_tool'],
    matcher: { kind: 'values', values: ['startup', 'resume', 'clear', 'compact', 'fork'] },
    ifRuns: false, thenAnswers: ['addContext', 'tellUser', 'watchFiles'], exit2Blocks: false,
  },
  SessionEnd: {
    // All SessionEnd hooks share a 1.5 s budget (raised to match a longer hook, up to 60 s).
    // That is a shared budget, not a per-hook default, so no defaultTimeoutSeconds here.
    hookTypes: NO_AI,
    matcher: { kind: 'values', values: ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] },
    ifRuns: false, thenAnswers: [], exit2Blocks: false,
  },
  Stop: {
    // "Stop Claude" is not confirmed on Stop in the research, so it is not offered.
    hookTypes: ALL_FIVE, matcher: NONE, ifRuns: false,
    thenAnswers: ['block', 'addContext', 'tellUser'], exit2Blocks: true,
  },
  StopFailure: {
    hookTypes: NO_AI,
    matcher: {
      kind: 'values',
      values: [
        'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold',
        'billing_error', 'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens',
        'cloud_credential_error', 'unknown',
      ],
    },
    ifRuns: false, thenAnswers: [], exit2Blocks: false,
  },
  SubagentStart: {
    hookTypes: NO_AI, matcher: AGENT_TYPES, ifRuns: false,
    thenAnswers: ['addContext', 'tellUser'], exit2Blocks: false,
  },
  SubagentStop: {
    // "Stop Claude" is not confirmed on SubagentStop in the research, so it is not offered.
    hookTypes: ALL_FIVE, matcher: AGENT_TYPES, ifRuns: false,
    thenAnswers: ['block', 'addContext', 'tellUser'], exit2Blocks: true,
  },
  PreCompact: {
    hookTypes: NO_AI, matcher: COMPACT_TRIGGERS, ifRuns: false, thenAnswers: ['block'], exit2Blocks: true,
  },
  PostCompact: {
    hookTypes: NO_AI, matcher: COMPACT_TRIGGERS, ifRuns: false, thenAnswers: [], exit2Blocks: false,
  },
  PreModelSwitch: {
    hookTypes: NO_AI, matcher: MODEL_NAMES, ifRuns: false,
    thenAnswers: ['block', 'tellUser'], exit2Blocks: true, defaultTimeoutSeconds: 30,
  },
  PostModelSwitch: {
    hookTypes: NO_AI, matcher: MODEL_NAMES, ifRuns: false,
    thenAnswers: ['addContext', 'tellUser'], exit2Blocks: false, defaultTimeoutSeconds: 30,
  },
  PermissionRequest: {
    // Takes four types: an agent hook is skipped here. Its answer is a decision
    // object, which no Then block writes yet.
    hookTypes: ['command', 'http', 'mcp_tool', 'prompt'], matcher: TOOL, ifRuns: true,
    thenAnswers: ['tellUser'], exit2Blocks: false,
  },
  PermissionDenied: {
    hookTypes: ALL_FIVE, matcher: TOOL, ifRuns: true, thenAnswers: ['tellUser'], exit2Blocks: false,
  },
  Setup: {
    // Conflict in the research: the block catalog report (H "Setup") says command
    // only; the events report says command and mcp_tool. This table follows the
    // block catalog report.
    hookTypes: ['command'], matcher: { kind: 'values', values: ['init', 'maintenance'] },
    ifRuns: false, thenAnswers: [], exit2Blocks: false,
  },
  TeammateIdle: {
    hookTypes: ALL_FIVE, matcher: NONE, ifRuns: false, thenAnswers: ['stopClaude', 'tellUser'], exit2Blocks: true,
  },
  TaskCreated: {
    // continue: false is discarded on TaskCreated, so "Stop Claude" is not offered.
    hookTypes: ALL_FIVE, matcher: NONE, ifRuns: false, thenAnswers: ['block', 'tellUser'], exit2Blocks: true,
  },
  TaskCompleted: {
    hookTypes: ALL_FIVE, matcher: NONE, ifRuns: false, thenAnswers: ['stopClaude', 'tellUser'], exit2Blocks: true,
  },
  Elicitation: {
    hookTypes: NO_AI, matcher: MCP_SERVERS, ifRuns: false, thenAnswers: ['block'], exit2Blocks: true,
  },
  ElicitationResult: {
    hookTypes: NO_AI, matcher: MCP_SERVERS, ifRuns: false, thenAnswers: ['block'], exit2Blocks: true,
  },
  ConfigChange: {
    // Exit 2 blocks every source except policy_settings.
    hookTypes: NO_AI,
    matcher: { kind: 'values', values: ['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills'] },
    ifRuns: false, thenAnswers: ['block'], exit2Blocks: true,
  },
  WorktreeCreate: {
    // A command hook must print the new folder path, not JSON, so no Then answer fits.
    hookTypes: NO_AI, matcher: NONE, ifRuns: false, thenAnswers: [], exit2Blocks: true,
  },
  WorktreeRemove: {
    hookTypes: NO_AI, matcher: NONE, ifRuns: false, thenAnswers: [], exit2Blocks: true,
  },
  InstructionsLoaded: {
    hookTypes: NO_AI,
    matcher: { kind: 'values', values: ['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact'] },
    ifRuns: false, thenAnswers: [], exit2Blocks: false,
  },
  CwdChanged: {
    hookTypes: NO_AI, matcher: NONE, ifRuns: false, thenAnswers: ['tellUser', 'watchFiles'], exit2Blocks: false,
  },
  FileChanged: {
    // The matcher names the files to watch, split on "|".
    hookTypes: NO_AI, matcher: { kind: 'fileNames' }, ifRuns: false,
    thenAnswers: ['tellUser', 'watchFiles'], exit2Blocks: false,
  },
  DirectoryAdded: {
    // Conflict in the research: one line says systemMessage shows on DirectoryAdded,
    // and the "no output control" list names DirectoryAdded. No Then answer is offered.
    hookTypes: NO_AI, matcher: { kind: 'values', values: ['slash_command', 'register_repo_root'] },
    ifRuns: false, thenAnswers: [], exit2Blocks: false,
  },
  MessageDisplay: {
    hookTypes: NO_AI, matcher: NONE, ifRuns: false, thenAnswers: [], exit2Blocks: false, defaultTimeoutSeconds: 10,
  },
};

/** The rule for one event, or null when Claude Code has no such event. */
export function eventRule(event: string): EventRule | null {
  return Object.prototype.hasOwnProperty.call(EVENT_RULES, event) ? EVENT_RULES[event as HookEventName] : null;
}

const TYPE_DEFAULT_TIMEOUT: Readonly<Record<HookType, number>> = {
  command: 600,
  http: 600,
  mcp_tool: 600,
  prompt: 30,
  agent: 60,
};

/** What "Gives up after" means when the user leaves it alone. */
export function defaultTimeoutSeconds(event: string, type: HookType): number {
  return eventRule(event)?.defaultTimeoutSeconds ?? TYPE_DEFAULT_TIMEOUT[type];
}

/** The text fields each hook type must have. A hook without them is read-only in the hook editor. */
export const REQUIRED_FIELDS: Readonly<Record<HookType, readonly string[]>> = {
  command: ['command'],
  http: ['url'],
  mcp_tool: ['server', 'tool'],
  prompt: ['prompt'],
  agent: ['prompt'],
};
