/**
 * The schema-lane hooks a desktop tracker engine runs with: `tracker_type_defs`
 * for type definitions and the predicate and label registry lanes, installed into this
 * process's registry. Shared by the production engine and the scripted-IPC test
 * engine so the two cannot drift.
 */

import type { TrackerSchemaSyncHooks } from '@nimbalyst/tracker-engine';
import {
  applyRemoteWorkspaceTrackerSchemaDef,
  applyWorkspaceLabelRegistryInProcess,
  applyWorkspacePredicateRegistryInProcess,
  encodeTrackerSchemaDefForPush,
} from '../TrackerSchemaService';
import { listUnsyncedTrackerSchemaDefs, markTrackerSchemaDefRejected } from './trackerTypeDefStore';
import { composeTrackerSchemaSyncHooks } from './trackerSchemaSyncHooks';
import {
  clearDialogTypeCreation,
  isDialogTypeCreation,
  publishTrackerSchemaOutcome,
  retireLostTrackerTypeCreation,
} from './trackerSchemaCreationOutcome';
import { isPermanentTrackerRejection, type TrackerMutationRejectCode } from '@nimbalyst/tracker-engine';

export function createDesktopTrackerSchemaSyncHooks(workspacePath: string): TrackerSchemaSyncHooks {
  return composeTrackerSchemaSyncHooks(workspacePath, {
    // An override of a builtin goes out as a DELTA so each peer resolves it
    // against its own builtin and keeps receiving shipped fields (#1178).
    listUnsynced: async () =>
      (await listUnsyncedTrackerSchemaDefs(workspacePath)).map((def) => encodeTrackerSchemaDefForPush(
        def.createOnly && isDialogTypeCreation(workspacePath, def.type) ? { ...def, createOnly: 'required' as const } : def,
      )),
    applyRemote: async (def) => {
      const result = await applyRemoteWorkspaceTrackerSchemaDef(workspacePath, def);
      // A definition from the room for a type someone here is waiting to create
      // means another client created it first (see trackerSchemaCreationOutcome).
      if (result.applied && def.model !== null) publishTrackerSchemaOutcome(workspacePath, def.type, { kind: 'roomDefined' });
      return result;
    },
    markRejected: (type) => markTrackerSchemaDefRejected(workspacePath, type),
    onSettled: ({ type, accepted, error }) => {
      const dialogCreation = isDialogTypeCreation(workspacePath, type);
      const unsupported = error?.code === 'createOnlyUnsupported';
      if (accepted || unsupported || isPermanentTrackerRejection(error?.code as TrackerMutationRejectCode)) {
        clearDialogTypeCreation(workspacePath, type);
      }
      // Never sent, so no server refusal will retire it: without this the row
      // stays queued and, once no longer a dialog creation, would go out as the
      // plain upsert `required` exists to prevent.
      if (unsupported && dialogCreation) {
        void markTrackerSchemaDefRejected(workspacePath, type)
          .then(() => retireLostTrackerTypeCreation(workspacePath, type))
          .catch((err) => console.error('[TrackerSchemaSync] could not retire an unsent type creation', type, err));
      }
      publishTrackerSchemaOutcome(workspacePath, type, { kind: 'settled', accepted, code: error?.code, message: error?.message });
    },
  }, { onApplied: applyWorkspacePredicateRegistryInProcess }, { onApplied: applyWorkspaceLabelRegistryInProcess });
}
