import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import chokidar from 'chokidar';
import { clearTrackerSchemaLoadFailure, recordTrackerSchemaLoadFailure } from './trackerSchemaLoadFailures';
import {
  globalRegistry,
  registryTrackerTypeLookup,
  resolveTrackerTypeInheritance,
  type TrackerDataModel,
  type TrackerTypeDeclaration,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  materializeYamlTrackerTypeDef,
} from './trackerTypeDefStore';
import {
  evaluateTrackerSchemaChange,
  resolveTrackerSchemaActorRole,
  type TrackerSchemaChangeDecision,
} from './trackerSchemaChangeGuard';
import {
  isSelfWrittenSchemaFile,
  normalizedForSchemaComparison,
  parseSyncedTrackerSchemaModel,
  projectedSchemaFormForFile,
  refreshSharedSchemaHeader,
  resolveOwningTeamName,
  parseSchemaDeclarationFromContent,
  writeBackSharedSchema,
} from './trackerSchemaProjection';
import {
  isTrackerSchemaFile,
  shouldIgnoreTrackerWatchPath,
} from '../trackerSchemaWatchUtils';
import { getCurrentIdentity } from '../TrackerIdentityService';
import { logger } from '../../utils/logger';

let watcher: ReturnType<typeof chokidar.watch> | null = null;

/**
 * Price a watched file edit against the guard rail. Never throws, but a `null`
 * result is NOT an allow: the classifier's own rule is that a change it cannot
 * prove additive is destructive, so a classifier that fails to run at all is the
 * strongest possible version of "unknown". The caller re-applies D3's admin
 * split over `null` rather than letting the edit through.
 */
async function classifyWatchedSchemaEdit(
  workspacePath: string,
  previous: TrackerDataModel | undefined,
  next: TrackerDataModel,
): Promise<TrackerSchemaChangeDecision | null> {
  try {
    return await evaluateTrackerSchemaChange({
      workspacePath,
      previous: previous && normalizedForSchemaComparison(previous),
      next: normalizedForSchemaComparison(next),
      confirmed: false,
      teamName: await resolveOwningTeamName(workspacePath),
    });
  } catch (err) {
    logger.main.warn('[TrackerSchemaService] schema change guard failed for', next.type, err);
    return null;
  }
}

/**
 * A member removed part of a team tracker's schema by hand. The edit cannot be
 * pushed (D3) and cannot be left loaded either — running a schema nobody else has
 * is the divergence the sharing model exists to prevent. So the team's copy is
 * restored over the file, which is the documented server-wins outcome, and the
 * member's version is preserved beside it rather than discarded.
 */
async function restoreTeamSchemaOverLocalEdit(
  workspacePath: string,
  filePath: string,
  teamModel: TrackerDataModel | undefined,
  reason: string,
): Promise<void> {
  logger.main.warn(
    `[TrackerSchemaService] refused non-admin destructive edit to team schema at ${filePath}: ${reason}`,
  );
  try {
    await fsPromises.copyFile(filePath, `${filePath}.${Date.now()}.bak`);
  } catch (err) {
    logger.main.warn('[TrackerSchemaService] could not preserve refused schema edit:', err);
  }
  if (!teamModel) return;
  await writeBackSharedSchema(workspacePath, teamModel, globalRegistry.isBuiltin(teamModel.type));
}

/**
 * The service exports a two-argument wrapper ONLY so
 * `TrackerSchemaService.sharedSchemaWriteBack.test.ts` can drive a hand edit
 * without a real chokidar watcher. That shortcut hides the property this
 * function's #1178 safety rests on: the watcher is created with
 * `ignoreInitial: true` (see `watchSchemaDirectory`) and the startup directory
 * read does NOT route through it, so reaching here really does mean "a file
 * changed after we loaded it". If that option ever goes away, every stale
 * checked-in YAML starts pushing itself to the whole team on launch.
 */
export async function reloadWorkspaceSchemaFile(
  workspacePath: string,
  filePath: string,
  notifySchemaChanged: () => void,
): Promise<void> {
  if (isSelfWrittenSchemaFile(filePath)) return; // our own write-back, not a user edit
  const fileName = path.basename(filePath);
  // What gets registered: a derived type stays declared so base changes reach it.
  let declared: TrackerTypeDeclaration;
  let content: string | null = null;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
    declared = parseSchemaDeclarationFromContent(fileName, content);
  } catch (err) {
    console.error(`[TrackerSchemaService] Failed to reload ${filePath}:`, err);
    recordTrackerSchemaLoadFailure(workspacePath, filePath, err, content);
    return;
  }
  const resolution = resolveTrackerTypeInheritance(declared, registryTrackerTypeLookup);
  if (!resolution.model) {
    if (resolution.errors.every((error) => error.code === 'INHERITANCE_UNKNOWN_BASE')) {
      // A subtype saved before its base. Register the declaration so the
      // registry resolves it the moment the base loads; there is nothing to
      // gate or mirror until then.
      globalRegistry.register(declared);
      notifySchemaChanged();
      logger.main.info(`[TrackerSchemaService] '${declared.type}' is waiting for its base type: ${resolution.errors[0]?.message}`);
      return;
    }
    const message = resolution.errors.map((e) => e.message).join('; ');
    console.error(`[TrackerSchemaService] Failed to reload ${filePath}:`, message);
    recordTrackerSchemaLoadFailure(workspacePath, filePath, new Error(message), content);
    return;
  }
  const model: TrackerDataModel = resolution.model;

  // A hand edit cannot carry a confirmation: the file is already saved by the
  // time we hear about it, and there is no modal to show at watcher time. So the
  // guard here is only the half that a confirmation could never have supplied
  // anyway -- D3's admin split -- and only for a TEAM tracker, where the edit
  // would otherwise be pushed to everyone. A personal tracker's file is its own
  // authority and is left on the fast path below, unslowed and unquestioned.
  const previousModel = globalRegistry.get(model.type);
  if (previousModel?.sharing === 'team' || model.sharing === 'team') {
    const decision = await classifyWatchedSchemaEdit(workspacePath, previousModel, model);
    if (!decision) {
      // The guard could not be computed at all. Treating that as an allow was a
      // fail-open: any classifier error let a member's hand edit load and queue
      // itself for the team. Re-apply D3 over the unknown instead — an admin's
      // edit still applies (unpriced, and logged as such), a member's does not.
      const actorRole = await resolveTrackerSchemaActorRole(workspacePath);
      if (actorRole !== 'admin') {
        await restoreTeamSchemaOverLocalEdit(
          workspacePath,
          filePath,
          previousModel,
          'the change could not be classified',
        );
        return;
      }
      logger.main.warn(
        `[TrackerSchemaService] applying unclassifiable admin edit to team schema '${model.type}'; blast radius unknown`,
      );
    } else if (!decision.verdict.allowed && decision.verdict.reason === 'requires-admin') {
      await restoreTeamSchemaOverLocalEdit(
        workspacePath,
        filePath,
        previousModel,
        decision.blastRadiusText,
      );
      return;
    }
    if (decision?.classification.classification === 'destructive') {
      // An admin who typed the removal into the file and saved it has already
      // made the deliberate choice a dialog would have asked for; what they have
      // not been told is the size of it. Report rather than block.
      logger.main.warn(
        `[TrackerSchemaService] destructive team schema edit applied to '${model.type}': ${decision.blastRadiusText}`,
      );
    }
  }

  // Register and notify BEFORE the sync bookkeeping below, and synchronously
  // with the watcher event. Loading the schema the user just edited is the
  // point; mirroring it into the DB is a side effect. Ordering it the other way
  // both left the registry stale for anything reading it on the same tick and
  // made a personal tracker's edit fail to load whenever unrelated team-schema
  // work threw.
  const waitingBefore = globalRegistry.getUnresolvedDerivedTypes();
  globalRegistry.register(declared);
  clearTrackerSchemaLoadFailure(workspacePath, filePath);
  // Subtypes that were waiting on this type resolve now (the registry
  // re-resolves dependents on every register); they still need mirroring.
  const nowResolved = waitingBefore.filter((type) => globalRegistry.get(type));
  // console.log(`[TrackerSchemaService] Reloaded schema: ${model.type}`);
  notifySchemaChanged();

  try {
    // Yaml-aware mirror write: for a team-owned type this either no-ops (the
    // file matches the shared definition) or queues the user's edit (#1178).
    // A team-owned type this workspace never projected has no baseline to diff
    // against, and the store cannot invent one -- but a watcher event is the
    // intent signal it lacks, so supply the baseline here: what THIS file would
    // hold if it carried the shared definition. Nothing is written to disk; the
    // file already holds the edit.
    await materializeYamlTrackerTypeDef(workspacePath, model, undefined, {
      establishBaseline: (sharedModelJson) => {
        const shared = parseSyncedTrackerSchemaModel(model.type, sharedModelJson);
        if (!shared) return null;
        return JSON.stringify(projectedSchemaFormForFile(fileName, shared));
      },
      activity: {
        authorIdentity: getCurrentIdentity(workspacePath),
        action: 'schema_updated',
        details: { field: 'schema' },
      },
    });
    if (model.sharing === 'team') {
      globalRegistry.register(declared);
      await refreshSharedSchemaHeader(workspacePath, filePath, model);
    }
  } catch (err) {
    console.error(`[TrackerSchemaService] Failed to mirror ${model.type} after reload:`, err);
  }

  for (const type of nowResolved) {
    const dependent = globalRegistry.get(type);
    if (dependent) await materializeYamlTrackerTypeDef(workspacePath, dependent);
  }
}

export function watchSchemaDirectory(
  workspacePath: string,
  reloadWorkspaceSchema: (workspacePath: string, filePath: string) => Promise<void>,
  handleSchemaFileDeleted: (workspacePath: string, filePath: string) => Promise<void>,
  reloadPredicateRegistry: (workspacePath: string) => Promise<void>,
  reloadLabelRegistry?: (workspacePath: string) => Promise<void>,
): void {
  stopSchemaWatcher();

  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  const predicateRegistryPath = path.join(workspacePath, '.nimbalyst', 'predicates.yaml');
  const labelRegistryPath = path.join(workspacePath, '.nimbalyst', 'labels.yaml');
  // Both registries reload the same way on add, change, and unlink.
  const reloadRegistry = (filePath: string): boolean => {
    const resolved = path.resolve(filePath);
    if (resolved === path.resolve(predicateRegistryPath)) {
      void reloadPredicateRegistry(workspacePath);
      return true;
    }
    if (resolved === path.resolve(labelRegistryPath)) {
      if (reloadLabelRegistry) void reloadLabelRegistry(workspacePath);
      return true;
    }
    return false;
  };

  // Watch the parent even before either artifact exists so creating the first
  // tracker type or predicate registry is observed without a restart.
  const nimbalystDir = path.dirname(trackersDir);
  if (!fs.existsSync(nimbalystDir)) return;

  watcher = chokidar.watch([trackersDir, predicateRegistryPath, labelRegistryPath], {
    // Ignore dotfiles inside the watched directory, but do not ignore the
    // parent `.nimbalyst` segment itself or chokidar drops every event.
    ignored: (candidatePath: string) => shouldIgnoreTrackerWatchPath(trackersDir, candidatePath),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
    depth: 0, // only watch the directory itself, not subdirs
  });

  watcher
    .on('change', (filePath: string) => {
      if (reloadRegistry(filePath)) return;
      if (isTrackerSchemaFile(filePath)) {
        void reloadWorkspaceSchema(workspacePath, filePath);
      }
    })
    .on('add', (filePath: string) => {
      if (reloadRegistry(filePath)) return;
      if (isTrackerSchemaFile(filePath)) {
        void reloadWorkspaceSchema(workspacePath, filePath);
      }
    })
    .on('unlink', (filePath: string) => {
      if (reloadRegistry(filePath)) return;
      if (isTrackerSchemaFile(filePath)) {
        // Async since the handler has to ask whether the team owns a copy, so a
        // throw here would surface as an unhandled rejection rather than on the
        // watcher callback the way it did when this was synchronous.
        handleSchemaFileDeleted(workspacePath, filePath).catch((err) => {
          console.error(`[TrackerSchemaService] Failed to handle deletion of ${filePath}:`, err);
        });
      }
    })
    .on('error', (error: unknown) => {
      console.error('[TrackerSchemaService] Watcher error:', error);
    });
}

export function stopSchemaWatcher(): void {
  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
  }
}
