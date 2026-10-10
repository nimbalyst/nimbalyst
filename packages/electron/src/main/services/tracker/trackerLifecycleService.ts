/**
 * Tracker lifecycle operations for the UI: promote a personal tracker to the
 * team, and archive/unarchive a team tracker.
 *
 * These transitions already existed as agent tools. This module is their
 * surface for a person, not a second implementation: both funnel through
 * `handleTrackerDefineType`, which owns the one-way promotion guard, the schema
 * write, the DB mirror, and the publish-existing-items sweep that mints keys.
 * Reimplementing any of that here would give the UI and the agent two different
 * answers to "what does promotion do".
 *
 * The one thing added on top is patch MERGING: the schema patch file is written
 * whole, so flipping one flag has to carry the tracker's existing overrides
 * with it or a click of "Archive" would quietly discard someone's custom
 * fields.
 */

import path from 'path';
import fsPromises from 'fs/promises';
import { safeHandle } from '../../utils/ipcRegistry';
import { handleTrackerDefineType } from '../../mcp/tools/trackerToolHandlers';
import { ensureWorkspaceTrackerSchemasLoaded } from '../TrackerSchemaService';
import {
  clearDialogTypeCreation,
  listenForTrackerSchemaOutcome,
  markDialogTypeCreation,
  retireLostTrackerTypeCreation,
} from './trackerSchemaCreationOutcome';
import {
  globalRegistry,
  parseTrackerSchemaPatchYAML,
  resolveTrackerPromotionEligibility,
  type TrackerSchemaPatch,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

export interface TrackerPromotionSummary {
  publishedCount: number;
  assignedKeyCount: number;
  pendingKeyCount: number;
}

/** Mirrors `TrackerSchemaService`'s deterministic patch file name. */
function patchFilePath(workspacePath: string, type: string): string {
  return path.join(workspacePath, '.nimbalyst', 'trackers', `${type}.patch.yaml`);
}

/**
 * The tracker's existing patch, so a one-flag change is a delta on top of it
 * rather than a replacement of it. No patch on disk yet is the normal case.
 */
async function readExistingPatch(workspacePath: string, type: string): Promise<TrackerSchemaPatch | null> {
  try {
    const content = await fsPromises.readFile(patchFilePath(workspacePath, type), 'utf-8');
    return parseTrackerSchemaPatchYAML(content);
  } catch {
    return null;
  }
}

interface DefineTypeStructuredResult {
  type: string;
  promotion?: TrackerPromotionSummary;
}

/**
 * Apply a lifecycle flag change through the agent-facing define-type path and
 * unwrap its MCP-shaped result.
 */
async function applyLifecycleChange(
  workspacePath: string,
  type: string,
  change: Pick<TrackerSchemaPatch, 'sharing' | 'archived'>,
  options?: { promoteExistingItems?: boolean },
): Promise<DefineTypeStructuredResult> {
  const existing = await readExistingPatch(workspacePath, type);
  const patch: TrackerSchemaPatch = { ...(existing ?? {}), type, ...change };

  const result = await handleTrackerDefineType(
    { patch, overwrite: true, promoteExistingItems: options?.promoteExistingItems === true },
    workspacePath,
  );
  const first = result.content?.[0];
  const text = first?.type === 'text' ? first.text ?? '' : '';
  if (result.isError) {
    throw new Error(text || `Could not update tracker '${type}'.`);
  }
  try {
    return JSON.parse(text).structured as DefineTypeStructuredResult;
  } catch {
    // The write succeeded; only the envelope was unreadable.
    return { type };
  }
}

/**
 * Promote a personal tracker to the team. One-way by design: every existing
 * item is published now and receives its server-issued key at that moment.
 */
export async function promoteTrackerToTeam(
  workspacePath: string,
  type: string,
): Promise<TrackerPromotionSummary> {
  ensureWorkspaceTrackerSchemasLoaded(workspacePath);
  const model = globalRegistry.get(type);
  if (!model) throw new Error(`Unknown tracker type '${type}'`);
  const eligibility = resolveTrackerPromotionEligibility(model);
  if (!eligibility.canPromote) {
    throw new Error(eligibility.message ?? `Tracker '${type}' cannot be shared with the team.`);
  }

  const structured = await applyLifecycleChange(
    workspacePath,
    type,
    { sharing: 'team' },
    { promoteExistingItems: true },
  );
  return structured.promotion ?? { publishedCount: 0, assignedKeyCount: 0, pendingKeyCount: 0 };
}

/**
 * Archive or unarchive a tracker. Items are untouched: they stay in place,
 * stay searchable, and keep their keys. Only writes are refused afterwards.
 */
export async function setTrackerArchived(
  workspacePath: string,
  type: string,
  archived: boolean,
): Promise<void> {
  ensureWorkspaceTrackerSchemasLoaded(workspacePath);
  if (!globalRegistry.get(type)) throw new Error(`Unknown tracker type '${type}'`);
  await applyLifecycleChange(workspacePath, type, { archived });
}

/** How long a team type's creation waits for the room before saying it is still syncing. */
const TEAM_TYPE_OUTCOME_TIMEOUT_MS = 10_000;

export type NewTrackerTypeResult = {
  type: string;
  scope: 'team' | 'personal';
  /** `syncing`: written here, and the room has not answered yet. */
  status: 'created' | 'syncing';
};

/**
 * Create a new type from the Pages "New type..." dialog. The schema's own
 * `sharing` (or its parent's, for a subtype) decides team or personal, exactly
 * as for the agent tool. Creation never replaces: an id already registered is
 * refused here, and `overwrite: false` makes the write path refuse an existing
 * file too.
 *
 * A personal type is done when it is written. A team type is done when the room
 * accepts this creation: another client may have created the same id first, and
 * the room refuses ours (`schemaExists`) rather than replacing theirs. That is
 * reported to the caller, and the losing local file is retired so it is not
 * left behind looking like the person's own type.
 */
export async function defineNewTrackerType(
  workspacePath: string,
  schema: { type?: unknown } & Record<string, unknown>,
  options: { outcomeTimeoutMs?: number } = {},
): Promise<NewTrackerTypeResult> {
  if (typeof schema?.type !== 'string' || !schema.type) throw new Error('A new type needs a type id.');
  const type = schema.type;
  ensureWorkspaceTrackerSchemasLoaded(workspacePath);
  if (globalRegistry.get(type)) throw new Error(`A type named "${type}" already exists.`);

  const outcome = listenForTrackerSchemaOutcome(workspacePath, type);
  // Before the write: its push may start before the write's promise resolves.
  markDialogTypeCreation(workspacePath, type);
  let scope: 'team' | 'personal';
  try {
    const result = await handleTrackerDefineType({ schema, overwrite: false }, workspacePath);
    const first = result.content?.[0];
    const text = first?.type === 'text' ? first.text ?? '' : '';
    if (result.isError) throw new Error(text.replace(/^Error:\s*/, '') || `Could not create type '${type}'.`);
    try {
      scope = (JSON.parse(text).structured as { changeScope?: string }).changeScope === 'team' ? 'team' : 'personal';
    } catch {
      scope = schema.sharing === 'team' ? 'team' : 'personal';
    }
  } catch (error) {
    outcome.cancel();
    clearDialogTypeCreation(workspacePath, type);
    throw error;
  }
  if (scope === 'personal') {
    outcome.cancel();
    clearDialogTypeCreation(workspacePath, type);
    return { type, scope, status: 'created' };
  }

  const answer = await outcome.wait(options.outcomeTimeoutMs ?? TEAM_TYPE_OUTCOME_TIMEOUT_MS);
  if (!answer) return { type, scope, status: 'syncing' };
  if (answer.kind === 'settled' && answer.accepted) return { type, scope, status: 'created' };
  if (answer.kind === 'roomDefined' || answer.code === 'schemaExists') {
    await retireLostTrackerTypeCreation(workspacePath, type);
    throw new Error(`Someone else just created a type named "${type}". Pick another name.`);
  }
  throw new Error(answer.message || `The team refused the new type (${answer.code ?? 'unknown'}).`);
}

export function registerTrackerLifecycleIpc(): void {
  safeHandle('tracker-lifecycle:define-type', async (
    _event,
    payload: { workspacePath: string; schema: { type?: unknown } & Record<string, unknown> },
  ) => {
    if (!payload?.workspacePath) throw new Error('workspacePath is required');
    if (!payload?.schema) throw new Error('schema is required');
    try {
      return { success: true, ...(await defineNewTrackerType(payload.workspacePath, payload.schema)) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('tracker-lifecycle:promote', async (_event, payload: { workspacePath: string; type: string }) => {
    if (!payload?.workspacePath) throw new Error('workspacePath is required');
    if (!payload?.type) throw new Error('type is required');
    try {
      const promotion = await promoteTrackerToTeam(payload.workspacePath, payload.type);
      return { success: true, promotion };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('tracker-lifecycle:set-archived', async (
    _event,
    payload: { workspacePath: string; type: string; archived: boolean },
  ) => {
    if (!payload?.workspacePath) throw new Error('workspacePath is required');
    if (!payload?.type) throw new Error('type is required');
    try {
      await setTrackerArchived(payload.workspacePath, payload.type, payload.archived === true);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
