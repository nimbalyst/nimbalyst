/**
 * Composes the single ProjectConfig blob that desktop publishes to mobile.
 *
 * The blob is a whole-object replace on the wire: `projectConfigUpdate` writes
 * `encrypted_config` outright, so whoever sends it must send *everything*. It
 * has two independent producers -- slash commands (from `slash-command:list`)
 * and action prompts (from ai-actions.md) -- which update at different times
 * and from different triggers. If each producer built its own blob, whichever
 * sent last would silently erase the other's half.
 *
 * So producers do not send. They update their slice here, and this module
 * composes the whole blob from the latest known value of both slices.
 *
 * Main cannot recompute the command list on its own -- `listEntries` needs the
 * provider-native commands/skills that only the running provider knows -- so
 * the last value the renderer reported is cached rather than re-derived.
 */

import type { SyncedSlashCommand, SyncedActionPrompt } from '@nimbalyst/runtime/sync/types';
import { hasPublishableConfig } from '@nimbalyst/runtime/sync/projectConfig';
import type { ActionPrompt } from '../ActionPromptParser';

// Re-exported so callers and tests have one import for the compose step and the
// publish decision, while the predicate itself stays next to the send site.
export { hasPublishableConfig };

/**
 * Per-action body budget. Bodies are prompts, not documents; the largest real
 * one observed is a few hundred bytes. This is a guard against a pathological
 * file, not a tuned limit.
 */
export const MAX_ACTION_BODY_CHARS = 4000;

/**
 * Total budget for all action bodies in one blob. The blob lands in a single
 * DO SQLite row alongside the command list, so it cannot grow without bound.
 * Actions past this point are dropped rather than truncated -- a half-list of
 * whole prompts is more useful than a whole list of fragments.
 */
export const MAX_ACTIONS_TOTAL_CHARS = 64000;

/** Hard cap on action count, so a generated file cannot produce a huge picker. */
export const MAX_ACTIONS = 100;

export interface ProjectConfigSlices {
  commands: SyncedSlashCommand[];
  lastCommandsUpdate: number;
  actions: SyncedActionPrompt[];
  lastActionsUpdate: number;
  gitRemoteHash?: string;
}

export interface ComposedProjectConfig {
  commands: SyncedSlashCommand[];
  lastCommandsUpdate: number;
  gitRemoteHash?: string;
  actions?: SyncedActionPrompt[];
  lastActionsUpdate?: number;
}

/**
 * Project the desktop's ActionPrompt onto the wire shape, applying the size
 * budget. Returns the kept actions plus what was dropped, so the caller can log
 * it rather than silently shipping a shortened list.
 */
export function toSyncedActionPrompts(actions: ActionPrompt[]): {
  actions: SyncedActionPrompt[];
  droppedForCount: number;
  droppedForSize: number;
  truncatedCount: number;
} {
  const kept: SyncedActionPrompt[] = [];
  let usedChars = 0;
  let droppedForSize = 0;
  let truncatedCount = 0;

  const withinCount = actions.slice(0, MAX_ACTIONS);
  const droppedForCount = actions.length - withinCount.length;

  for (const action of withinCount) {
    let body = action.body;
    let truncated = false;
    if (body.length > MAX_ACTION_BODY_CHARS) {
      body = body.slice(0, MAX_ACTION_BODY_CHARS);
      truncated = true;
    }

    // Drop rather than truncate once the total budget is gone: a fragment of a
    // prompt sent to an agent is worse than no prompt at all.
    if (usedChars + body.length > MAX_ACTIONS_TOTAL_CHARS) {
      droppedForSize++;
      continue;
    }
    usedChars += body.length;
    if (truncated) truncatedCount++;

    const synced: SyncedActionPrompt = {
      id: action.id,
      label: action.label,
      body,
    };
    if (truncated) synced.truncated = true;

    // Only launcher actions carry launch metadata. Same-session actions are the
    // default and stay minimal on the wire.
    if (action.config?.launch === 'new-session') {
      synced.launch = 'new-session';
      if (action.config.model) synced.model = action.config.model;
      synced.autoSubmit = action.config.autoSubmit;
      synced.worktree = action.config.worktree;
    }

    kept.push(synced);
  }

  return { actions: kept, droppedForCount, droppedForSize, truncatedCount };
}

/**
 * Build the wire blob from both slices.
 *
 * `actions` is omitted entirely when empty so that a desktop with no
 * ai-actions.md produces exactly the payload it produced before this feature —
 * an older phone sees no new key, and a newer phone sees "no actions" rather
 * than an empty array it has to distinguish from absent.
 */
export function composeProjectConfig(slices: ProjectConfigSlices): ComposedProjectConfig {
  const config: ComposedProjectConfig = {
    commands: slices.commands,
    lastCommandsUpdate: slices.lastCommandsUpdate,
    gitRemoteHash: slices.gitRemoteHash,
  };
  if (slices.actions.length > 0) {
    config.actions = slices.actions;
    config.lastActionsUpdate = slices.lastActionsUpdate;
  }
  return config;
}
