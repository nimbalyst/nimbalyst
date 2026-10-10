/**
 * The room's answer to a new team type created on this machine, for a caller
 * that has to tell a person whether it worked (the Pages "New type..." dialog).
 *
 * The schema lane pushes in the background, so the local write alone says
 * nothing about the team. Two things can settle a creation:
 *
 *  - `settled`: the room answered this client's own create-only mutation. The
 *    desktop schema hooks publish it from `onSettled`, which the engine matches
 *    by mutation id, never by type.
 *  - `roomDefined`: the room's definition of the same type was applied here
 *    before this creation was answered -- another client created it first and
 *    its broadcast won the race to this machine.
 *
 * Both of the second kind are the same outcome for the person: the name is
 * taken. In-process only; nothing here persists.
 */

import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getDatabase } from '../../database/initialize';
import { retireLocalSchemaFile } from './trackerSchemaProjection';

export type TrackerSchemaCreationOutcome =
  | { kind: 'settled'; accepted: boolean; code?: string; message?: string }
  | { kind: 'roomDefined' };

type Listener = (outcome: TrackerSchemaCreationOutcome) => void;

const listeners = new Map<string, Set<Listener>>();
const keyOf = (workspacePath: string, type: string) => `${workspacePath}\u0000${type}`;

/** Called by the desktop schema hooks; a no-op when nobody is waiting. */
export function publishTrackerSchemaOutcome(
  workspacePath: string,
  type: string,
  outcome: TrackerSchemaCreationOutcome,
): void {
  for (const listener of [...(listeners.get(keyOf(workspacePath, type)) ?? [])]) listener(outcome);
}

/**
 * Start listening BEFORE the local write: the push can be answered before the
 * write's own promise resolves. Resolves with null on timeout.
 */
export function listenForTrackerSchemaOutcome(
  workspacePath: string,
  type: string,
): { wait: (timeoutMs: number) => Promise<TrackerSchemaCreationOutcome | null>; cancel: () => void } {
  const key = keyOf(workspacePath, type);
  let first: TrackerSchemaCreationOutcome | null = null;
  let notify: ((outcome: TrackerSchemaCreationOutcome) => void) | null = null;
  const listener: Listener = (outcome) => {
    if (first) return;
    first = outcome;
    notify?.(outcome);
  };
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  const cancel = () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
  const wait = (timeoutMs: number) => new Promise<TrackerSchemaCreationOutcome | null>((resolve) => {
    // Declared before any path can call `finish`: an answer that arrived while
    // the local write was still running settles on the first line below (RV2-9).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: TrackerSchemaCreationOutcome | null) => {
      if (timer !== undefined) clearTimeout(timer);
      cancel();
      resolve(outcome);
    };
    if (first) {
      finish(first);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    notify = finish;
  });
  return { wait, cancel };
}

/**
 * Types created from the New type dialog and not yet answered by the room.
 * Their push is create-only `required`: an older room that cannot refuse an
 * existing type never receives them as a plain upsert. The agent tool's
 * creations are not in here and keep `whenSupported`.
 *
 * In memory: a restart before the room answers pushes the row with the agent
 * tool's `whenSupported` mode.
 */
const dialogCreations = new Set<string>();

export function markDialogTypeCreation(workspacePath: string, type: string): void {
  dialogCreations.add(keyOf(workspacePath, type));
}

export function clearDialogTypeCreation(workspacePath: string, type: string): void {
  dialogCreations.delete(keyOf(workspacePath, type));
}

export function isDialogTypeCreation(workspacePath: string, type: string): boolean {
  return dialogCreations.has(keyOf(workspacePath, type));
}

/**
 * A creation that lost the race must not stay on disk as the person's own type.
 * When the room's definition has already replaced the local row (`sync_id` set),
 * the file is the team's projection and stays. Otherwise the local file is
 * renamed to a `.bak` (recoverable, ignored by the loader) and the type leaves
 * this window's registry until the room's definition arrives.
 */
export async function retireLostTrackerTypeCreation(workspacePath: string, type: string): Promise<void> {
  const db = getDatabase();
  const result = db
    ? (await db.query(
        `SELECT sync_id FROM tracker_type_defs WHERE workspace = $1 AND type = $2`,
        [workspacePath, type],
      )) as { rows?: Array<{ sync_id: number | null }> } | undefined
    : undefined;
  const syncId = result?.rows?.[0]?.sync_id ?? null;
  if (syncId != null) return;
  await retireLocalSchemaFile(workspacePath, type);
  globalRegistry.clearWorkspaceSchema(type);
}
