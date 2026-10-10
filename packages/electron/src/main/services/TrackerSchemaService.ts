/**
 * TrackerSchemaService -- main-process authority for tracker schemas.
 *
 * Loads built-in schemas and workspace YAML schemas, watches for changes,
 * and exposes schemas to the renderer and MCP via IPC.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { isTrackerSchemaFile } from './trackerSchemaWatchUtils';
import {
  globalRegistry,
  loadBuiltinTrackers,
  parseTrackerTypeYAML,
  resolveTrackerTypeDeclaration,
  resolveTrackerTypeDeclarations,
  declarationForResolvedModel,
  registryTrackerTypeLookup,
  serializeTrackerYAML,
  normalizeTrackerSharingModel,
  serializeTrackerSchemaPatchYAML,
  resolveTrackerSchemaPatch,
  diffTrackerSchema,
  decodeTrackerSchemaPayload,
  encodeTrackerSchemaPatchPayload,
  encodeTrackerSchemaModelPayload,
  TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
  TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
  resolveTrackerTypeInheritance,
  type TrackerDataModel,
  type DerivedTrackerTypeDeclaration,
  type TrackerTypeDeclaration,
  type TrackerSchemaPatch,
  type TrackerSchemaRole,
  getRoleField,
  getFieldByRole,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  materializeYamlTrackerTypeDefs,
  listRetractedTeamOwnedTrackerTypes,
  reconcileYamlTrackerTypeDefs,
  listMaterializedTrackerTypeDefs,
  classifyTrackerSchemaDrift,
  hasSchemaDrift,
  applyRemoteTrackerSchemaDef,
  removeTrackerTypeDef,
  type SchemaDriftEntry,
  type RemoteTrackerSchemaDef,
  type ApplyRemoteSchemaResult,
  type TypeDefDb,
} from './tracker/trackerTypeDefStore';
import {
  evaluateTrackerSchemaChange,
  TrackerSchemaChangeBlockedError,
  type TrackerSchemaChangeDecision,
} from './tracker/trackerSchemaChangeGuard';
import type { LabelRegistry, PredicateDefinition, TrackerSchemaActorRole } from '@nimbalyst/tracker-schema';
import {
  installTrackerSchemaScopeProvider,
  runWithTrackerSchemaWorkspace,
} from './tracker/trackerSchemaScope';
import {
  getWindowIdForWindow,
  resolveActiveWorkspacePathForWindowId,
} from '../window/windowState';
import { getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { logger } from '../utils/logger';
import {
  migrateTrackerSharingModels,
  type LegacyTrackerSyncPolicy,
} from './TrackerPolicyService';
import {
  findWorkspaceSchemaFileByType,
  normalizedForSchemaComparison,
  orderSchemaFilesForLoad,
  parseSchemaDeclarationFromContent,
  readWorkspaceSchemaModelsFromDisk,
  parseSyncedTrackerSchemaForm,
  parseSyncedTrackerSchemaModel,
  patchFileNameForType,
  registerResolvedTrackerSchema,
  projectUnprojectedSharedSchemas,
  resolveOwningTeamName,
  resolveSchemaModelFromContent,
  retireLocalSchemaFile,
  serializeSchemaForFile,
  writeBackSharedSchema,
} from './tracker/trackerSchemaProjection';
import { readWorkspacePredicateRegistry } from './tracker/trackerPredicateRegistryFile';
import { clearTrackerSchemaLoadFailures, recordTrackerSchemaLoadFailure } from './tracker/trackerSchemaLoadFailures';
import { applyRemotePredicateRegistry } from './tracker/trackerPredicateRegistrySync';
import { readWorkspaceLabelRegistry } from './tracker/trackerLabelRegistryFile';
import { readTrackerWorkspaceVocabulary } from './tracker/trackerWorkspaceVocabulary';
import { applyRemoteLabelRegistry } from './tracker/trackerLabelRegistrySync';
import { requestTrackerSchemaFlush } from './tracker/trackerSchemaFlush';
import {
  reloadWorkspaceSchemaFile,
  stopSchemaWatcher,
  watchSchemaDirectory as startSchemaWatcher,
} from './tracker/trackerSchemaWatcher';

export {
  GIT_TRACKED_TEAM_SCHEMA_WARNING,
  getTrackerSchemaOwnershipDetails,
  isGitTrackedTrackerSchemaFile,
  refreshSharedSchemaHeader,
  writeThroughTeamTrackerSchemaEdit,
} from './tracker/trackerSchemaProjection';
export type { TrackerSchemaOwnershipDetails } from './tracker/trackerSchemaProjection';

// ---------------------------------------------------------------------------
// Service State
// ---------------------------------------------------------------------------

let initialized = false;
let currentWorkspacePath: string | null = null;

/**
 * Set the workspace that owns the live registry view. Always go through this
 * instead of assigning `currentWorkspacePath` directly: the registry needs to
 * know which workspace `models` represents so a lookup on behalf of a DIFFERENT
 * workspace resolves against that workspace's own layer rather than corrupting
 * this one (#1035).
 */
function setCurrentWorkspacePath(workspacePath: string | null): void {
  currentWorkspacePath = workspacePath;
  globalRegistry.setActiveWorkspace(workspacePath);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the TrackerSchemaService.
 * Loads built-in schemas, loads workspace YAML schemas, starts file watcher.
 */
export function initTrackerSchemaService(workspacePath?: string | null): void {
  if (!initialized) {
    loadBuiltinTrackers();
    installTrackerSchemaScopeProvider();
    registerIpcHandlers();
    initialized = true;
  }

  if (workspacePath && workspacePath !== currentWorkspacePath) {
    setCurrentWorkspacePath(workspacePath);
    loadWorkspaceSchemas(workspacePath);
    watchSchemaDirectory(workspacePath);
  }
}

/**
 * Update the workspace path for schema loading.
 * Called when a new workspace is opened.
 */
export function updateTrackerSchemaWorkspace(workspacePath: string | null): void {
  if (workspacePath === currentWorkspacePath) return;
  const previous = currentWorkspacePath;
  setCurrentWorkspacePath(workspacePath);

  if (workspacePath) {
    loadWorkspaceSchemas(workspacePath); // clears old workspace schemas first
    watchSchemaDirectory(workspacePath);
  } else {
    globalRegistry.clearWorkspaceSchemas();
    stopWatcher();
  }

  // The workspace that just stopped being active keeps its schemas somewhere
  // readable. Otherwise the only record of its custom types was the live view
  // we just overwrote, and every later read on its behalf -- notably the
  // reconnect drain, which is not scoped and cannot be -- resolves nothing
  // (NIM-3702). Its own YAML is the source; this is a demotion, not a load.
  if (previous && previous !== workspacePath) ensureWorkspaceTrackerSchemasLoaded(previous);
}

// ---------------------------------------------------------------------------
// Schema Loading
// ---------------------------------------------------------------------------

interface LoadedWorkspaceSchemaFile {
  fileName: string;
  filePath: string;
  content: string;
  model: TrackerDataModel;
}

function migrateWorkspaceTrackerSharing(
  workspacePath: string,
  trackersDir: string,
  loadedFiles: LoadedWorkspaceSchemaFile[],
  finalize = false,
): TrackerDataModel[] {
  const state = getWorkspaceState(workspacePath) as ReturnType<typeof getWorkspaceState> & {
    trackerSyncPolicies?: Record<string, LegacyTrackerSyncPolicy>;
  };
  const legacyPolicies = state.trackerSyncPolicies ?? {};
  const visibleModels = globalRegistry.getAll();
  const { models, report } = migrateTrackerSharingModels(visibleModels, legacyPolicies);
  const migratedByType = new Map(models.map((model) => [model.type, model]));
  const loadedTypes = new Set(loadedFiles.map((file) => file.model.type));
  const migratedWorkspaceModels: TrackerDataModel[] = [];

  for (const loaded of loadedFiles) {
    const migrated = migratedByType.get(loaded.model.type) ?? loaded.model;
    const changedByPolicy = migrated.sharing !== loaded.model.sharing ||
      migrated.draftByDefault !== loaded.model.draftByDefault;
    const hasLegacyShape = /(^|\n)sync:\s*(?:\n|$)/m.test(loaded.content);
    if (changedByPolicy || hasLegacyShape) {
      fs.writeFileSync(loaded.filePath, serializeSchemaForFile(loaded.fileName, migrated), 'utf-8');
    }
    // A subtype stays registered as its declaration; see registerResolvedTrackerSchema.
    registerResolvedTrackerSchema(migrated);
    migratedWorkspaceModels.push(migrated);
  }

  // A policy could have overridden a builtin without creating a YAML override.
  // Materialize that winning item policy into the schema so the removed
  // per-machine setting cannot continue as a hidden second axis.
  for (const trackerType of Object.keys(legacyPolicies)) {
    if (loadedTypes.has(trackerType)) continue;
    const migrated = migratedByType.get(trackerType);
    const original = visibleModels.find((model) => model.type === trackerType);
    if (!migrated || !original) continue;
    if (migrated.sharing === original.sharing && migrated.draftByDefault === original.draftByDefault) continue;
    fs.mkdirSync(trackersDir, { recursive: true });
    const fileName = globalRegistry.isBuiltin(trackerType)
      ? patchFileNameForType(trackerType)
      : `${trackerType}.yaml`;
    fs.writeFileSync(path.join(trackersDir, fileName), serializeSchemaForFile(fileName, migrated), 'utf-8');
    globalRegistry.register(migrated);
    migratedWorkspaceModels.push(migrated);
  }

  const shouldPersistReport = state.trackerSharingMigration?.version !== 1 || Object.keys(legacyPolicies).length > 0;
  if (shouldPersistReport) {
    const entriesByType = new Map(
      (finalize ? state.trackerSharingMigration?.entries ?? [] : report.entries)
        .map((entry) => [entry.trackerType, entry]),
    );
    const supplementalEntries = finalize ? report.entries : state.trackerSharingMigration?.entries ?? [];
    for (const entry of supplementalEntries) {
      if (!entriesByType.has(entry.trackerType)) entriesByType.set(entry.trackerType, entry);
    }
    const entries = Array.from(entriesByType.values());
    const persistedReport = {
      version: 1 as const,
      migratedAt: state.trackerSharingMigration?.migratedAt ?? report.migratedAt,
      entries,
      divergences: entries.filter((entry) => entry.diverged),
    };
    updateWorkspaceState(workspacePath, (draft) => {
      if (finalize) {
        delete (draft as typeof draft & { trackerSyncPolicies?: unknown }).trackerSyncPolicies;
      }
      draft.trackerSharingMigration = persistedReport;
    });
    for (const divergence of report.divergences) {
      logger.main.warn('[TrackerSharingMigration] resolved divergent schema/item policy', {
        workspacePath,
        ...divergence,
      });
    }
  }

  return migratedWorkspaceModels;
}

function loadWorkspaceSchemas(workspacePath: string): void {
  // Clear any schemas from a previous workspace before loading new ones
  globalRegistry.clearWorkspaceSchemas();

  // The predicate registry (knowledge-scopes 4.1) is a sibling schema artifact,
  // so it loads on the same trigger. A null read at startup means there is no
  // valid registry to load. Later hand edits are handled by the watcher below,
  // which keeps the last valid in-memory registry while a file is malformed.
  const localPredicates = readWorkspacePredicateRegistry(workspacePath);
  if (localPredicates) globalRegistry.setPredicates(localPredicates);
  const localLabels = readWorkspaceLabelRegistry(workspacePath);
  if (localLabels) globalRegistry.setLabels(localLabels);

  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');

  let loaded: TrackerDataModel[] = [];
  const loadedFiles: LoadedWorkspaceSchemaFile[] = [];
  let shouldReconcileYamlMirror = false;
  clearTrackerSchemaLoadFailures(workspacePath);
  try {
    if (fs.existsSync(trackersDir)) {
      const files = orderSchemaFilesForLoad(fs.readdirSync(trackersDir).filter(
        f => f.endsWith('.yaml') || f.endsWith('.yml')
      ));
      shouldReconcileYamlMirror = true;

      // Register declarations first and read resolved models after, so a
      // derived type (`extends`) loads whichever order its base's file sorts in.
      const declaredFiles: Array<Omit<LoadedWorkspaceSchemaFile, 'model'> & { type: string }> = [];
      for (const file of files) {
        const filePath = path.join(trackersDir, file);
        let content: string | null = null;
        try {
          content = fs.readFileSync(filePath, 'utf-8');
          const declared = parseSchemaDeclarationFromContent(file, content);
          globalRegistry.register(declared); // workspace schemas are not builtin
          declaredFiles.push({ fileName: file, filePath, content, type: declared.type });
          // console.log(`[TrackerSchemaService] Loaded workspace schema: ${declared.type}`);
        } catch (err) {
          console.error(`[TrackerSchemaService] Failed to load ${file}:`, err);
          recordTrackerSchemaLoadFailure(workspacePath, filePath, err, content);
        }
      }
      for (const { type, ...file } of declaredFiles) {
        const model = globalRegistry.get(type);
        if (!model) {
          console.error(`[TrackerSchemaService] Failed to load ${file.fileName}: '${type}' extends a type that is not defined`);
          recordTrackerSchemaLoadFailure(workspacePath, file.filePath, new Error(`'${type}' extends a type that is not defined`), file.content);
          continue;
        }
        loaded.push(model);
        loadedFiles.push({ ...file, model });
      }
    } else {
      shouldReconcileYamlMirror = true;
    }
  } catch (err) {
    // Directory can't be read. Do not reconcile against an empty YAML set here:
    // a transient permission/filesystem error should not tombstone every
    // YAML-sourced row in tracker_type_defs.
    console.error(`[TrackerSchemaService] Failed to read tracker schemas from ${trackersDir}:`, err);
  }

  loaded = migrateWorkspaceTrackerSharing(workspacePath, trackersDir, loadedFiles);

  // Mirror the loaded models into the DB so the database is the local source of
  // truth for offline consumers (the `nim` CLI), then reconcile: tombstone any
  // YAML-sourced type whose file was deleted on disk so the mirror stays an
  // accurate reflection of the YAML set. Best-effort; never blocks schema
  // loading. YAML stays the init/import format for git-backed projects.
  void (async () => {
    try {
      if (shouldReconcileYamlMirror) {
        // Yaml-aware: a team-owned type's shared definition outranks whatever is
        // on this machine's disk, so the mirror write must not clobber it (#1178).
        if (loaded.length) await materializeYamlTrackerTypeDefs(workspacePath, loaded);
        await reconcileYamlTrackerTypeDefs(workspacePath, loaded.map(m => m.type));
      }
      // Register DB-materialized types that have no local YAML (synced or
      // CLI-created) so a tracker type shared via schema sync survives restart.
      // loadWorkspaceSchemas only reads YAML, so without this the type vanishes
      // from the registry after restart (the incremental schema delta never
      // re-arrives). See NIM-865. Guard against a workspace switch that lands
      // while the DB reads above are in flight: only mutate the shared registry
      // if this workspace is still the active one.
      await registerMaterializedSyncedTypes(
        workspacePath,
        undefined,
        () => currentWorkspacePath === workspacePath,
      );
      // DB-native types are only visible after the async registration above.
      // Finalize now so their legacy item policies participate before the old
      // per-machine map is deleted.
      const finalizedMigrationModels = migrateWorkspaceTrackerSharing(
        workspacePath,
        trackersDir,
        [],
        true,
      );
      if (finalizedMigrationModels.length) {
        await materializeYamlTrackerTypeDefs(workspacePath, finalizedMigrationModels);
      }
      await reconcileRetractedTeamSchemas(workspacePath);
      await projectUnprojectedSharedSchemas(workspacePath);
    } catch (err) {
      console.error('[TrackerSchemaService] post-load schema mirror/register failed:', err);
    }
  })();
}

/**
 * Register active DB-materialized tracker types whose authoritative definition
 * is the DB mirror (source='sync' or 'cli'), so a tracker type shared via schema
 * sync or created by the CLI survives restart. loadWorkspaceSchemas only reads
 * YAML, so without this the type vanishes from the registry after restart (the
 * incremental schema delta never re-arrives). See NIM-865.
 *
 * Purely-local YAML rows are skipped: the on-disk YAML was already registered
 * from source by loadWorkspaceSchemas and is authoritative for a type the team
 * does not share; overwriting it with the mirror copy would be wrong.
 *
 * A TEAM-OWNED row (`sync_id` set) is registered even when it is yaml-sourced.
 * The team's definition is the authority for a shared type — that is the whole
 * point of schema sync — and skipping it on `source = 'yaml'` is what let one
 * member's stale file freeze a type for their whole team (#1178).
 *
 * sync/cli rows ARE registered even when the type slot is already occupied — a
 * built-in always sits in the registry (`has()` is true), and a synced override
 * of a built-in (or a synced type that once collided with local YAML) must win
 * to match the live applyRemoteWorkspaceTrackerSchemaDef path, which always
 * `register()`s. The earlier `has()`-skip reverted synced overrides to the
 * built-in/YAML definition on every restart.
 *
 * The model column is stored as JSON TEXT; PGLite may hand it back as an object
 * and SQLite as a string, so parse defensively. See NIM-865 and DATABASE.md.
 *
 * `isStillActiveWorkspace`, when supplied, is re-checked AFTER the awaited DB
 * read and before any registry mutation: a workspace switch during that read
 * must not leak this workspace's types into the now-active workspace's registry.
 */
export async function registerMaterializedSyncedTypes(
  workspacePath: string,
  dbOverride?: TypeDefDb,
  isStillActiveWorkspace?: () => boolean,
): Promise<number> {
  const defs = await listMaterializedTrackerTypeDefs(workspacePath, dbOverride);
  // The DB read awaited above; bail before touching the shared registry if the
  // active workspace changed out from under us. DB writes are workspace-keyed
  // and safe to complete; only the in-memory registry can leak across projects.
  if (isStillActiveWorkspace && !isStillActiveWorkspace()) return 0;
  let registered = 0;
  const forms: NonNullable<ReturnType<typeof parseSyncedTrackerSchemaForm>>[] = [];
  for (const def of defs) {
    if (!def?.type) continue;
    // The on-disk YAML is authoritative only for a type the team does not share,
    // and it is already registered; never clobber it with the mirror copy.
    if (def.source === 'yaml' && def.sync_id == null) continue;
    // `model` is JSON TEXT on SQLite but may be a parsed object on PGLite;
    // parseSyncedTrackerSchemaForm wants a JSON string, so normalize.
    const raw: unknown = def.model;
    const form = parseSyncedTrackerSchemaForm(def.type, typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (form) forms.push(form);
  }
  // Bases before subtypes: a subtype row without a stored declaration recovers
  // one by diffing against its base, which must already be the team's.
  forms.sort((a, b) => Number(Boolean(a.model.extends)) - Number(Boolean(b.model.extends)));
  for (const { model, declared } of forms) {
    // A personal YAML schema is the durable result of the sharing migration.
    // Do not let a pre-migration team-owned mirror row reclaim the registry
    // during the short window before materialization clears its old sync_id.
    if (globalRegistry.get(model.type)?.sharing === 'personal') continue;
    registerResolvedTrackerSchema(model, declared);
    registered++;
  }
  if (registered > 0) notifySchemaChanged();
  return registered;
}

/**
 * Exported ONLY so `TrackerSchemaService.sharedSchemaWriteBack.test.ts` can
 * drive a hand edit without a real chokidar watcher. That shortcut hides the
 * property this function's #1178 safety rests on: the watcher is created with
 * `ignoreInitial: true` (see `watchSchemaDirectory`) and the startup directory
 * read does NOT route through it, so reaching here really does mean "a file
 * changed after we loaded it". If that option ever goes away, every stale
 * checked-in YAML starts pushing itself to the whole team on launch.
 */
export async function reloadWorkspaceSchema(workspacePath: string, filePath: string): Promise<void> {
  return reloadWorkspaceSchemaFile(workspacePath, filePath, notifySchemaChanged);
}

/**
 * Apply team-side schema retractions to this workspace: drop the dead type from
 * the registry and retire any local YAML file still defining it. Runs on load so
 * a tombstone delivered while this workspace was closed still lands.
 */
async function reconcileRetractedTeamSchemas(workspacePath: string): Promise<void> {
  const retracted = await listRetractedTeamOwnedTrackerTypes(workspacePath);
  for (const type of retracted) {
    await retireLocalSchemaFile(workspacePath, type);
    if (currentWorkspacePath === workspacePath) globalRegistry.clearWorkspaceSchema(type);
  }
  if (retracted.length && currentWorkspacePath === workspacePath) notifySchemaChanged();
}

export async function handleSchemaFileDeleted(workspacePath: string, filePath: string): Promise<void> {
  if (!isTrackerSchemaFile(filePath)) return;
  const disk = readWorkspaceSchemaModelsFromDisk(workspacePath);
  const typesOnDisk = new Set(disk.models.map((model) => model.type));
  const materialized = await listMaterializedTrackerTypeDefs(workspacePath);
  const missingTeamCopies = materialized.filter(
    (row) => row.sync_id != null && !typesOnDisk.has(row.type),
  );

  if (missingTeamCopies.length > 0) {
    for (const row of missingTeamCopies) {
      const form = parseSyncedTrackerSchemaForm(row.type, row.model);
      if (!form) continue;
      await writeBackSharedSchema(workspacePath, form.model, globalRegistry.isBuiltin(row.type), form.declared);
    }
    return;
  }

  // A personal schema really is file-owned, so deleting it removes that local
  // definition from the registry and mirror as before.
  if (currentWorkspacePath === workspacePath) {
    globalRegistry.clearWorkspaceSchemas();
    loadWorkspaceSchemas(workspacePath);
    notifySchemaChanged();
  }
}

// ---------------------------------------------------------------------------
// File Watcher
// ---------------------------------------------------------------------------

function watchSchemaDirectory(workspacePath: string): void {
  startSchemaWatcher(
    workspacePath,
    reloadWorkspaceSchema,
    handleSchemaFileDeleted,
    reloadWorkspacePredicateRegistry,
    reloadWorkspaceLabelRegistry,
  );
}

/** Reload a hand-edited predicates.yaml without replacing a valid registry by a parse failure. */
export async function reloadWorkspacePredicateRegistry(workspacePath: string): Promise<void> {
  const predicates = readWorkspacePredicateRegistry(workspacePath);
  if (predicates === null) return;
  // A hand edit is a save like any other: publish it to the room (NIM-6653).
  requestTrackerSchemaFlush(workspacePath);
  if (currentWorkspacePath === null || currentWorkspacePath === workspacePath) {
    globalRegistry.setPredicates(predicates);
    notifySchemaChanged();
  } else {
    globalRegistry.setWorkspacePredicateLayer(workspacePath, predicates);
  }
}

/** Reload a hand-edited labels.yaml; a parse failure keeps the registry in force. */
export async function reloadWorkspaceLabelRegistry(workspacePath: string): Promise<void> {
  const registry = readWorkspaceLabelRegistry(workspacePath);
  if (registry === null) return;
  requestTrackerSchemaFlush(workspacePath);
  applyWorkspaceLabelRegistryInProcess(workspacePath, registry);
}

function stopWatcher(): void {
  stopSchemaWatcher();
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

/**
 * The workspace a renderer request is asking about — the workspace of the window
 * that sent it, not whichever workspace last claimed the live registry view.
 *
 * The registry is process-global: opening a second window on another project
 * reverts every builtin override for EVERY window, so a project with custom
 * schemas silently shows builtins as soon as you open a second project (#1178).
 * Resolving per sender, against that workspace's own layer, keeps each window
 * looking at its own project's schemas.
 */
function workspacePathForEvent(event: { sender: Electron.WebContents }): string | null {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    return resolveActiveWorkspacePathForWindowId(getWindowIdForWindow(win)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Read schemas on behalf of `workspacePath`. The active workspace reads the live
 * view directly; any other workspace gets its own cached layer built first (YAML
 * on disk plus the DB mirror, so synced and CLI-created types are included) and
 * the read is scoped to it.
 */
async function readSchemasForWorkspace<T>(
  workspacePath: string | null,
  read: () => T,
): Promise<T> {
  if (!workspacePath || workspacePath === currentWorkspacePath) return read();
  await buildWorkspaceSchemaLayer(workspacePath);
  return runWithTrackerSchemaWorkspace(workspacePath, read);
}

/**
 * Populate the cached schema layer for a non-active workspace: its YAML models,
 * overlaid with the DB mirror for every type the DB owns (team-owned, synced or
 * CLI-created). Mirrors the precedence the active view gets from
 * loadWorkspaceSchemas + registerMaterializedSyncedTypes.
 */
/**
 * Rebuild a workspace's cached schema layer from disk plus the DB mirror.
 *
 * The tracker drain calls this before giving up on an unresolved policy: an
 * unresolvable type is usually a race with schema load rather than a real
 * absence, and "retry before you destroy" is the first requirement in
 * destructive-data-paths.md. Cheap next to a wrong delete.
 */
export async function refreshWorkspaceSchemaLayer(workspacePath: string): Promise<void> {
  if (!workspacePath || workspacePath === currentWorkspacePath) return;
  await buildWorkspaceSchemaLayer(workspacePath);
}

async function buildWorkspaceSchemaLayer(workspacePath: string): Promise<void> {
  const byType = new Map<string, TrackerDataModel>();
  for (const model of readWorkspaceSchemaModelsFromDisk(workspacePath).models) {
    byType.set(model.type, model);
  }
  try {
    for (const def of await listMaterializedTrackerTypeDefs(workspacePath)) {
      if (!def?.type) continue;
      if (def.source === 'yaml' && def.sync_id == null) continue;
      const raw: unknown = def.model;
      const model = parseSyncedTrackerSchemaModel(
        def.type,
        typeof raw === 'string' ? raw : JSON.stringify(raw),
      );
      if (model && byType.get(def.type)?.sharing !== 'personal') {
        byType.set(def.type, model);
      }
    }
  } catch (err) {
    console.error('[TrackerSchemaService] buildWorkspaceSchemaLayer mirror read failed:', err);
  }
  globalRegistry.setWorkspaceLayer(workspacePath, Array.from(byType.values()));
}

function registerIpcHandlers(): void {
  safeHandle('tracker-schema:get-all', async (event) => {
    return readSchemasForWorkspace(workspacePathForEvent(event), () =>
      globalRegistry.getAll().map(serializeModel),
    );
  });

  safeHandle('tracker-schema:get', async (event, type: string) => {
    return readSchemasForWorkspace(workspacePathForEvent(event), () => {
      const model = globalRegistry.get(type);
      return model ? serializeModel(model) : null;
    });
  });

  // The label and predicate registries of one workspace, so renderer surfaces
  // can resolve an item's effective properties. Re-read after every
  // `tracker-schema:changed`.
  safeHandle('tracker-schema:get-vocabulary', async (_event, workspacePath: string) => {
    return readTrackerWorkspaceVocabulary(workspacePath, {
      registry: globalRegistry,
      activeWorkspacePath: currentWorkspacePath,
      runScoped: runWithTrackerSchemaWorkspace,
      readLabels: readWorkspaceLabelRegistry,
      readPredicates: readWorkspacePredicateRegistry,
    });
  });

  safeHandle('tracker-schema:get-role-field', async (_event, type: string, role: TrackerSchemaRole) => {
    const model = globalRegistry.get(type);
    if (!model) return null;
    return getRoleField(model, role) ?? null;
  });

  safeHandle('tracker-schema:get-field-by-role', async (_event, type: string, role: TrackerSchemaRole) => {
    const field = getFieldByRole(globalRegistry, type, role);
    return field ?? null;
  });

  safeHandle('tracker-schema:get-drift', async (_event, workspacePath: string) => {
    return computeWorkspaceSchemaDrift(workspacePath);
  });

  safeHandle('tracker-schema:resync-mirror', async (_event, workspacePath: string) => {
    await resyncWorkspaceSchemaMirror(workspacePath);
    return computeWorkspaceSchemaDrift(workspacePath);
  });

  safeHandle('tracker-schema:get-override', async (_event, workspacePath: string, type: string) => {
    return getWorkspaceTrackerSchemaOverride(workspacePath, type);
  });

  safeHandle('tracker-schema:customize', async (_event, workspacePath: string, type: string) => {
    return customizeWorkspaceTrackerSchema(workspacePath, type);
  });

  safeHandle('tracker-schema:reset-override', async (
    _event,
    workspacePath: string,
    type: string,
    options?: TrackerSchemaWriteGuardOptions,
  ) => {
    return resetWorkspaceTrackerSchemaOverride(workspacePath, type, options);
  });

  // Read-only pricing for a confirm surface: what would this change cost, and is
  // the caller allowed to make it? Returns the verdict rather than throwing, so
  // the panel can render "you need an admin" as copy instead of an error.
  safeHandle('tracker-schema:preview-change', async (
    _event,
    workspacePath: string,
    type: string,
  ) => {
    const decision = await previewWorkspaceTrackerSchemaChange(workspacePath, type);
    return {
      classification: decision.classification.classification,
      verdict: decision.verdict,
      blastRadiusText: decision.blastRadiusText,
      copy: decision.copy,
    };
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Push the current schema set to every window — each in terms of ITS OWN
 * workspace. Broadcasting the active workspace's list to all windows is how a
 * second open project used to overwrite a window's schemas in place (#1178).
 */
function notifySchemaChanged(): void {
  const active = globalRegistry.getAll().map(serializeModel);
  for (const win of BrowserWindow.getAllWindows()) {
    const workspacePath = resolveActiveWorkspacePathForWindowId(getWindowIdForWindow(win)) ?? null;
    if (!workspacePath || workspacePath === currentWorkspacePath) {
      win.webContents.send('tracker-schema:changed', active);
      continue;
    }
    void readSchemasForWorkspace(workspacePath, () =>
      globalRegistry.getAll().map(serializeModel),
    )
      .then((schemas) => {
        if (!win.isDestroyed()) win.webContents.send('tracker-schema:changed', schemas);
      })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a TrackerDataModel for IPC transfer.
 * TrackerDataModel is already a plain object, but we ensure it's
 * JSON-safe (no class instances, functions, etc.).
 */
function serializeModel(model: TrackerDataModel): TrackerDataModel {
  return JSON.parse(JSON.stringify(model));
}

// ---------------------------------------------------------------------------
// Public API for other main-process services
// ---------------------------------------------------------------------------

export function getTrackerSchema(type: string): TrackerDataModel | undefined {
  return globalRegistry.get(type);
}

export function getAllTrackerSchemas(): TrackerDataModel[] {
  return globalRegistry.getAll();
}

/**
 * Ensure the given workspace's custom YAML tracker schemas are registered in the
 * global registry before an MCP tracker handler reads or validates a type.
 *
 * The registry is normally populated by window/session events
 * (`updateTrackerSchemaWorkspace`). But the in-process MCP HTTP server can serve
 * a tracker call when those events have not fired for this workspace, or after
 * another window cleared the workspace schemas -- leaving only builtins, so
 * custom types are invisible to `tracker_list_types` and rejected by
 * `tracker_create`/`tracker_update` (NIM-760).
 *
 * Reads the `.nimbalyst/trackers` YAML dir directly. Builtins are assumed loaded
 * by `initTrackerSchemaService` at startup.
 *
 * The registry is keyed by TYPE NAME ONLY, so this must never register another
 * project's schemas into the live view: two projects that both define `widget`
 * would otherwise share one slot, and a read-only MCP call for project B would
 * silently replace project A's `widget` schema — making A validate its items
 * against B's required fields and status options (#1035). So:
 *
 *  - active workspace (or none claimed yet): register into the live view, as
 *    before — additive and idempotent, never clearing, so synced/CLI-registered
 *    types with no YAML on disk survive (NIM-865).
 *  - any other workspace: populate that workspace's own cached layer. Reads made
 *    on behalf of it (see `runWithTrackerSchemaWorkspace`) resolve there, so its
 *    custom types stay visible (NIM-760) with the active view left untouched.
 */
export function ensureWorkspaceTrackerSchemasLoaded(workspacePath: string | null | undefined): void {
  if (!workspacePath) return;

  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  let files: string[];
  try {
    if (!fs.existsSync(trackersDir)) return;
    files = orderSchemaFilesForLoad(fs.readdirSync(trackersDir).filter(
      f => f.endsWith('.yaml') || f.endsWith('.yml'),
    ));
  } catch {
    return;
  }

  const isActive = currentWorkspacePath === null || currentWorkspacePath === workspacePath;
  const declarations: TrackerTypeDeclaration[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(trackersDir, file), 'utf-8');
      const declared = parseSchemaDeclarationFromContent(file, content);
      if (isActive) {
        globalRegistry.register(declared); // workspace schemas are not builtin
      } else {
        declarations.push(declared);
      }
    } catch (err) {
      console.error(`[TrackerSchemaService] ensureWorkspaceTrackerSchemasLoaded failed for ${file}:`, err);
    }
  }

  // Replace rather than merge: the full YAML dir was just re-read, so a type
  // whose file was deleted must not linger in the cached layer.
  if (!isActive) globalRegistry.setWorkspaceLayer(workspacePath, resolveTrackerTypeDeclarations(declarations));
}

export function isBuiltinTrackerSchema(type: string): boolean {
  return globalRegistry.isBuiltin(type);
}

export function getTrackerRoleField(type: string, role: TrackerSchemaRole): string | undefined {
  const model = globalRegistry.get(type);
  if (!model) return undefined;
  return getRoleField(model, role);
}

function normalizeSchemaFileName(type: string, fileName?: string): string {
  const candidate = (fileName?.trim() || `${type}.yaml`);
  if (path.basename(candidate) !== candidate) {
    throw new Error('fileName must be a plain file name within .nimbalyst/trackers');
  }
  if (!candidate.endsWith('.yaml') && !candidate.endsWith('.yml')) {
    return `${candidate}.yaml`;
  }
  return candidate;
}

export function refreshWorkspaceSchemasIfCurrent(workspacePath: string): void {
  // Also load when currentWorkspacePath is null -- no workspace has been set yet
  // (happens when upsertWorkspaceTrackerSchema is called before any workspace window opens).
  if (currentWorkspacePath !== null && workspacePath !== currentWorkspacePath) {
    // Its window only learns of new types from this push (per-window scoped).
    notifySchemaChanged();
    return;
  }
  setCurrentWorkspacePath(workspacePath);
  loadWorkspaceSchemas(workspacePath);
  watchSchemaDirectory(workspacePath);
  notifySchemaChanged();
}

/** Thrown by upsertWorkspaceTrackerSchema when a type already exists and the
 *  caller did not opt into overwriting. `.code` lets callers map it to a
 *  friendly tool error without string-matching the message. */
export class TrackerTypeExistsError extends Error {
  readonly code = 'TRACKER_TYPE_EXISTS';
  constructor(
    readonly type: string,
    readonly filePath: string,
  ) {
    super(
      `Tracker type '${type}' already exists at ${path.basename(filePath)}. ` +
      `Pass overwrite: true to replace it (the existing file is backed up first).`,
    );
    this.name = 'TrackerTypeExistsError';
  }
}

// ---------------------------------------------------------------------------
// Destructive-change guard rail (PRD principle 6 / D3)
// ---------------------------------------------------------------------------

export interface TrackerSchemaWriteGuardOptions {
  /** The caller showed the blast radius and the user approved it. */
  confirmDestructive?: boolean;
  /** Pre-resolved role; production leaves this unset and asks TeamService. */
  actorRole?: TrackerSchemaActorRole;
}

/**
 * Every schema write that can still say "no" runs through here BEFORE anything
 * touches disk or the mirror. Additive changes fall straight through with no
 * role check and no dialog — that is the point of the rule, not a gap in it.
 */

async function gateSchemaWrite(
  workspacePath: string,
  previous: TrackerDataModel | undefined,
  next: TrackerDataModel,
  options?: TrackerSchemaWriteGuardOptions,
): Promise<TrackerSchemaChangeDecision> {
  const isTeam = previous?.sharing === 'team' || next.sharing === 'team';
  const decision = await evaluateTrackerSchemaChange({
    workspacePath,
    previous: previous && normalizedForSchemaComparison(previous),
    next: normalizedForSchemaComparison(next),
    confirmed: options?.confirmDestructive === true,
    actorRole: options?.actorRole,
    teamName: isTeam ? await resolveOwningTeamName(workspacePath) : undefined,
  });
  if (!decision.verdict.allowed) throw new TrackerSchemaChangeBlockedError(next.type, decision);
  return decision;
}

/**
 * What resetting a workspace override lands on: the shipped builtin when there is
 * one, otherwise the type ceases to exist, which is every field removed at once.
 */
function schemaResetTarget(type: string, previous: TrackerDataModel): TrackerDataModel {
  return globalRegistry.getBuiltinModel(type) ?? { ...previous, fields: [], roles: {} };
}

/**
 * Price a proposed schema change without applying it, so a confirm surface can
 * show the blast radius before the user commits. Read-only.
 */
export async function previewWorkspaceTrackerSchemaChange(
  workspacePath: string,
  type: string,
  next?: TrackerDataModel,
): Promise<TrackerSchemaChangeDecision> {
  if (!workspacePath) throw new Error('workspacePath is required');
  ensureWorkspaceTrackerSchemasLoaded(workspacePath);
  const previous = globalRegistry.get(type);
  const target = next ?? (previous ? schemaResetTarget(type, previous) : undefined);
  if (!target) throw new Error(`Unknown tracker type '${type}'`);
  const isTeam = previous?.sharing === 'team' || target.sharing === 'team';
  return evaluateTrackerSchemaChange({
    workspacePath,
    previous: previous && normalizedForSchemaComparison(previous),
    next: normalizedForSchemaComparison(target),
    confirmed: false,
    teamName: isTeam ? await resolveOwningTeamName(workspacePath) : undefined,
  });
}

export async function upsertWorkspaceTrackerSchema(
  workspacePath: string,
  schema: TrackerDataModel | string,
  options?: {
    fileName?: string;
    overwrite?: boolean;
    allowBuiltinOverride?: boolean;
  } & TrackerSchemaWriteGuardOptions,
): Promise<{ model: TrackerDataModel; filePath: string; backupPath?: string }> {
  if (!workspacePath) throw new Error('workspacePath is required');

  const yamlContent = typeof schema === 'string' ? schema : serializeTrackerYAML(schema);
  // A derived type is written as declared and resolved against its base here,
  // which both validates it and gives the gate a full model to compare.
  const model = resolveTrackerTypeDeclaration(parseTrackerTypeYAML(yamlContent));

  if (globalRegistry.isBuiltin(model.type) && !options?.allowBuiltinOverride) {
    throw new Error(`Cannot redefine built-in tracker type '${model.type}'`);
  }

  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  await fsPromises.mkdir(trackersDir, { recursive: true });

  const existingFilePath = await findWorkspaceSchemaFileByType(workspacePath, model.type);

  // Guard against silent data loss: `.nimbalyst/` is gitignored, so blindly
  // overwriting an existing custom-type definition (e.g. an agent that called
  // tracker_define_type because tracker_list_types hid the type) destroys it
  // with no recovery. Refuse unless the caller opts in, and back up first.
  // Ordered ahead of the destructive gate on purpose: "this type already exists"
  // is the more actionable answer, and until the caller has opted into replacing
  // it there is no proposed change worth pricing.
  if (existingFilePath && !options?.overwrite) {
    throw new TrackerTypeExistsError(model.type, existingFilePath);
  }

  // Before the backup, before the write: a refused change leaves no trace. Keyed
  // on the model in force rather than on the file, so a team-synced type this
  // workspace has no YAML for is gated too.
  await gateSchemaWrite(workspacePath, globalRegistry.get(model.type), model, options);

  let backupPath: string | undefined;
  if (existingFilePath) {
    backupPath = `${existingFilePath}.${Date.now()}.bak`;
    await fsPromises.copyFile(existingFilePath, backupPath);
  }

  const filePath = existingFilePath ?? path.join(
    trackersDir,
    normalizeSchemaFileName(model.type, options?.fileName),
  );

  await fsPromises.writeFile(filePath, yamlContent, 'utf-8');
  refreshWorkspaceSchemasIfCurrent(workspacePath);

  return { model, filePath, backupPath };
}

/**
 * Persist a builtin (or custom) override as a delta patch under
 * `.nimbalyst/trackers/<type>.patch.yaml`. The patch is resolved against the live
 * seed first (validating it and producing the fully-resolved model the registry
 * and DB mirror hold). Overwriting an existing patch backs it up first — patches
 * are meant to be refined, so overwrite is the default, but recovery is preserved.
 */
export async function upsertWorkspaceTrackerSchemaPatch(
  workspacePath: string,
  patch: TrackerSchemaPatch,
  options?: { overwrite?: boolean } & TrackerSchemaWriteGuardOptions,
): Promise<{ model: TrackerDataModel; filePath: string; backupPath?: string }> {
  if (!workspacePath) throw new Error('workspacePath is required');
  if (!patch?.type) throw new Error('patch.type is required');

  const seed = globalRegistry.getBuiltinModel(patch.type) ?? globalRegistry.get(patch.type);
  if (!seed) throw new Error(`Cannot patch unknown tracker type '${patch.type}'`);

  // Resolve now to validate the patch and produce the resolved model. Throws on a
  // malformed patch (e.g. adding a field without a type) before anything is written.
  const model = resolveTrackerSchemaPatch(seed, patch);

  // Diff against what is IN FORCE, not against the builtin seed: a patch that
  // drops a field an earlier patch added is a removal to the items that already
  // carry it, however small the delta against the builtin looks.
  await gateSchemaWrite(workspacePath, globalRegistry.get(patch.type), model, options);

  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  await fsPromises.mkdir(trackersDir, { recursive: true });

  const filePath = path.join(trackersDir, patchFileNameForType(patch.type));

  let backupPath: string | undefined;
  const exists = await fsPromises
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    if (options?.overwrite === false) {
      throw new TrackerTypeExistsError(patch.type, filePath);
    }
    backupPath = `${filePath}.${Date.now()}.bak`;
    await fsPromises.copyFile(filePath, backupPath);
  }

  await fsPromises.writeFile(filePath, serializeTrackerSchemaPatchYAML(patch), 'utf-8');
  refreshWorkspaceSchemasIfCurrent(workspacePath);

  return { model, filePath, backupPath };
}

export async function getWorkspaceTrackerSchemaOverride(
  workspacePath: string,
  type: string,
): Promise<{ overridden: boolean; filePath?: string }> {
  if (!workspacePath || !type) return { overridden: false };
  const filePath = await findWorkspaceSchemaFileByType(workspacePath, type);
  return filePath ? { overridden: true, filePath } : { overridden: false };
}

export async function customizeWorkspaceTrackerSchema(
  workspacePath: string,
  type: string,
): Promise<{ model: TrackerDataModel; filePath: string; created: boolean }> {
  if (!workspacePath) throw new Error('workspacePath is required');
  if (!type) throw new Error('type is required');

  const existing = await findWorkspaceSchemaFileByType(workspacePath, type);
  if (existing) {
    // An override of a builtin is stored as `<type>.patch.yaml`, which
    // legitimately has no `displayName`; the full-model parser threw on it, the
    // IPC handler never returned a path, and the Settings -> Trackers edit
    // pencil silently did nothing for every overridden type (NIM-3065).
    // `resolveSchemaModelFromContent` is what the loader and watcher already
    // use and handles both file shapes.
    const content = await fsPromises.readFile(existing, 'utf-8');
    return { model: resolveSchemaModelFromContent(path.basename(existing), content), filePath: existing, created: false };
  }

  const model = globalRegistry.get(type);
  if (!model) throw new Error(`Unknown tracker type '${type}'`);

  const result = await upsertWorkspaceTrackerSchema(workspacePath, model, {
    fileName: `${type}.yaml`,
    allowBuiltinOverride: true,
  });
  return { model: result.model, filePath: result.filePath, created: true };
}

/**
 * Reset a workspace override back to the shipped default. On a TEAM tracker this
 * pushes a tombstone, so it resets the type for everyone — which is exactly the
 * shape principle 6 exists for, and why it is gated on the same rule as any other
 * removal rather than on "is this a builtin".
 */
export async function resetWorkspaceTrackerSchemaOverride(
  workspacePath: string,
  type: string,
  options?: TrackerSchemaWriteGuardOptions,
): Promise<{ reset: boolean; filePath?: string }> {
  const previous = globalRegistry.get(type);
  if (previous) {
    await gateSchemaWrite(workspacePath, previous, schemaResetTarget(type, previous), options);
  }
  const result = await deleteWorkspaceTrackerSchema(workspacePath, type, {
    allowBuiltinOverride: true,
  });
  if (result.deleted) {
    // Tombstone the DB mirror so the reset PROPAGATES: a team tracker override
    // pushes a tombstone that restores the builtin for the team. Reconcile only
    // tombstones yaml-sourced rows, so a cli/sync-sourced override row would
    // otherwise linger active and keep syncing the stale override. Best-effort.
    await removeTrackerTypeDef(workspacePath, type);
  }
  return { reset: result.deleted, filePath: result.filePath };
}

// ---------------------------------------------------------------------------
// Schema drift (Epic B Phase 2)
// ---------------------------------------------------------------------------

export interface WorkspaceSchemaDrift {
  entries: SchemaDriftEntry[];
  hasDrift: boolean;
}

/**
 * Compare the on-disk YAML schemas against the DB-materialized mirror and report
 * per-type drift. Powers the "schema mirror is out of date" warning in the
 * Trackers settings panel. Best-effort; returns an empty/clean result on error.
 */
export async function computeWorkspaceSchemaDrift(
  workspacePath: string,
): Promise<WorkspaceSchemaDrift> {
  if (!workspacePath) return { entries: [], hasDrift: false };
  try {
    const { models: yamlModels } = readWorkspaceSchemaModelsFromDisk(workspacePath);
    const dbDefs = await listMaterializedTrackerTypeDefs(workspacePath);
    const entries = classifyTrackerSchemaDrift(yamlModels, dbDefs);
    return { entries, hasDrift: hasSchemaDrift(entries) };
  } catch (err) {
    console.error('[TrackerSchemaService] computeWorkspaceSchemaDrift failed:', err);
    return { entries: [], hasDrift: false };
  }
}

/**
 * Force the DB mirror to exactly match the on-disk YAML set: re-materialize every
 * loaded YAML model, then tombstone any YAML-sourced row whose file is gone. This
 * is the non-destructive "reset from files" action - it never touches CLI/sync-
 * sourced (db-native) rows, only the YAML-mirrored ones.
 */
export async function resyncWorkspaceSchemaMirror(
  workspacePath: string,
): Promise<void> {
  if (!workspacePath) throw new Error('workspacePath is required');
  const { models: yamlModels, canReconcile } = readWorkspaceSchemaModelsFromDisk(workspacePath);
  if (!canReconcile) {
    throw new Error('Tracker schema directory could not be read; refusing to resync mirror.');
  }
  if (yamlModels.length) await materializeYamlTrackerTypeDefs(workspacePath, yamlModels);
  await reconcileYamlTrackerTypeDefs(workspacePath, yamlModels.map(m => m.type));
}

// ---------------------------------------------------------------------------
// Delta payloads for builtin overrides
// ---------------------------------------------------------------------------

/**
 * Resolve an inbound schema payload to a full model. A delta payload is applied
 * to THIS machine's builtin seed, so a teammate's override of `bug` picks up
 * whatever fields this app version's builtin ships — the point of sending a
 * delta rather than a frozen copy (#1178).
 *
 * Returns the resolved model plus whether it arrived as a delta, which decides
 * where write-back projects it (`<type>.patch.yaml` vs `<type>.yaml`).
 */
function resolveInboundSchemaPayload(
  type: string,
  modelJson: string,
): {
  model: TrackerDataModel;
  isPatch: boolean;
  declared?: DerivedTrackerTypeDeclaration;
  /** The declaration to persist with the mirror row and file, resolvable here or not. */
  declaredForm?: DerivedTrackerTypeDeclaration;
} | null {
  const decoded = decodeTrackerSchemaPayload(type, modelJson);
  if (!decoded) return null;
  if (decoded.kind === 'model') {
    // A derived type arrives as both forms. Prefer re-resolving the DECLARED
    // form against this machine's base, so a base field this app version ships
    // reaches the derived type instead of being frozen at the sender's version.
    // A payload from before declarations travelled recovers one from the base.
    // The sender's resolved model is the fallback when the base is unknown here.
    const declaredForm = declarationForResolvedModel(decoded.model, decoded.declared);
    if (declaredForm) {
      const { model, errors } = resolveTrackerTypeInheritance(declaredForm, registryTrackerTypeLookup);
      if (model) {
        return {
          model: normalizeTrackerSharingModel(model, 'team'),
          isPatch: false,
          // Only surfaced when the base resolved HERE. Registering a
          // declaration whose base this app does not know would drop the type
          // from the registry entirely, even though the mirror has a usable
          // resolved model.
          declared: declaredForm,
          declaredForm,
        };
      }
      console.warn(
        `[TrackerSchemaService] could not resolve '${type}' against the local base; using the sender's resolved model:`,
        errors.map(e => e.message).join('; '),
      );
    }
    return {
      model: normalizeTrackerSharingModel(decoded.model, 'team'),
      isPatch: false,
      declaredForm,
    };
  }

  if (decoded.kind === 'predicates' || decoded.kind === 'labels') {
    // Routed before this function is reached (see
    // `applyRemoteWorkspaceTrackerSchemaDef`). Arriving here means a registry
    // was published under a tracker type's schema row, which is a sender bug;
    // dropping it leaves that type's definition alone.
    console.warn(`[TrackerSchemaService] ${decoded.kind} registry published as tracker type '${type}'; dropped`);
    return null;
  }

  const seed = globalRegistry.getBuiltinModel(type);
  if (!seed) {
    // A delta with no local seed cannot be resolved. Dropping it is right: this
    // app version does not know the type the sender was patching.
    console.warn(`[TrackerSchemaService] schema patch for unknown builtin '${type}' dropped`);
    return null;
  }
  try {
    return { model: resolveTrackerSchemaPatch(seed, decoded.patch), isPatch: true };
  } catch (err) {
    console.error(`[TrackerSchemaService] failed to resolve schema patch for ${type}:`, err);
    return null;
  }
}

/**
 * Encode a locally-originated schema change for the wire. An override of a
 * BUILTIN travels as a delta against this app's builtin seed; a custom type the
 * team owns outright travels as its full model. Tombstones pass through.
 */
export function encodeTrackerSchemaDefForPush<T extends { type: string; model: string | null }>(
  def: T,
): T {
  if (def.model === null) return def;

  // A derived type travels as its resolved model PLUS its declaration, so a
  // peer can re-resolve against its own base (see the payload module).
  const form = parseSyncedTrackerSchemaForm(def.type, def.model);
  const declared = form?.declared ?? globalRegistry.getDeclaredModel(def.type);
  if (declared) {
    const model = form?.model ?? globalRegistry.get(def.type);
    if (model) return { ...def, model: encodeTrackerSchemaModelPayload(model, declared) };
  }

  if (!globalRegistry.isBuiltin(def.type)) return def;

  const seed = globalRegistry.getBuiltinModel(def.type);
  const model = parseSyncedTrackerSchemaModel(def.type, def.model);
  if (!seed || !model) return def;

  try {
    return { ...def, model: encodeTrackerSchemaPatchPayload(diffTrackerSchema(seed, model)) };
  } catch (err) {
    // Fall back to the full model rather than dropping the change: a frozen
    // copy is worse than a delta, but losing the override entirely is worse still.
    console.error(`[TrackerSchemaService] failed to diff ${def.type} against its builtin:`, err);
    return def;
  }
}

/**
 * Apply a server-confirmed schema sync delta. The DB mirror is authoritative
 * for transport state; the in-process registry is updated only when the delta
 * belongs to the active workspace, so background workspace sync cannot leak
 * schema definitions into another open project.
 */
export async function applyRemoteWorkspaceTrackerSchemaDef(
  workspacePath: string,
  def: RemoteTrackerSchemaDef,
): Promise<ApplyRemoteSchemaResult> {
  if (!workspacePath || !def?.type) return { applied: false, reason: 'invalid' };

  if (def.type === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE) {
    return applyRemoteWorkspacePredicateRegistry(workspacePath, def);
  }
  if (def.type === TRACKER_LABEL_REGISTRY_SCHEMA_TYPE) {
    return applyRemoteLabelRegistry(workspacePath, def, { onApplied: applyWorkspaceLabelRegistryInProcess });
  }

  // A personal schema on disk is the single-axis authority for this workspace.
  // This especially matters after migrating a legacy local item policy that
  // overrode a shared schema: the server may still offer the old team schema,
  // but accepting it would silently undo the required item-policy-wins result.
  const personalDivergence = getWorkspaceState(workspacePath).trackerSharingMigration?.divergences
    .find((entry) => entry.trackerType === def.type && entry.sharing === 'personal');
  if (personalDivergence) {
    logger.main.warn('[TrackerSharingMigration] ignored team schema for personal tracker', {
      workspacePath,
      trackerType: def.type,
      syncId: def.syncId,
    });
    return { applied: false, reason: 'personal' };
  }

  const resolved = def.model === null
    ? null
    : resolveInboundSchemaPayload(def.type, def.model);
  if (def.model !== null && !resolved) {
    return { applied: false, reason: 'invalid' };
  }
  const model = resolved?.model ?? null;

  // The mirror stores the RESOLVED model, never the delta: every consumer (the
  // registry, the `nim` CLI, drift detection) reads a full model, and the
  // resolution depends on this machine's builtin seed.
  // A subtype's declaration is stored beside it, so a restart registers the
  // declaration rather than this copy.
  const result = await applyRemoteTrackerSchemaDef(
    workspacePath,
    model ? { ...def, model: encodeTrackerSchemaModelPayload(model, resolved?.declaredForm) } : def,
  );
  if (!result.applied) return result;

  // Project the team's definition onto the workspace's YAML file. Without this
  // the file keeps whatever it had, and there is no baseline to tell a later
  // hand edit from a leftover -- so the edit could never be pushed (#1178).
  if (model && !result.deleted) {
    await writeBackSharedSchema(workspacePath, model, resolved?.isPatch ?? false, resolved?.declaredForm);
  }

  if (result.deleted) {
    await retireLocalSchemaFile(workspacePath, def.type);
  }

  if (currentWorkspacePath === workspacePath) {
    if (result.deleted) {
      globalRegistry.clearWorkspaceSchema(def.type);
    } else if (model) {
      // The declaration, when this machine could resolve it, so a later change
      // to the base type reaches this type without another sync round.
      registerResolvedTrackerSchema(model, resolved?.declared);
    }
    notifySchemaChanged();
  }

  return result;
}

/**
 * Apply a published PREDICATE REGISTRY (knowledge-scopes 4.1), which arrives on
 * the schema lane under the reserved schema type. The lane itself (version gate,
 * merge with the local copy, bookkeeping, push) is `trackerPredicateRegistrySync`;
 * this only installs the result in-process.
 */
function applyRemoteWorkspacePredicateRegistry(
  workspacePath: string,
  def: RemoteTrackerSchemaDef,
): Promise<ApplyRemoteSchemaResult> {
  return applyRemotePredicateRegistry(workspacePath, def, {
    onApplied: applyWorkspacePredicateRegistryInProcess,
  });
}

/** Install a registry for one workspace without leaking it into another open project. */
export function applyWorkspacePredicateRegistryInProcess(
  workspacePath: string,
  predicates: PredicateDefinition[],
): void {
  if (currentWorkspacePath === workspacePath) {
    globalRegistry.setPredicates(predicates);
    notifySchemaChanged();
  } else {
    globalRegistry.setWorkspacePredicateLayer(workspacePath, predicates);
  }
}

/** Install a label registry for one workspace without leaking it into another open project. */
export function applyWorkspaceLabelRegistryInProcess(workspacePath: string, registry: LabelRegistry): void {
  if (currentWorkspacePath === null || currentWorkspacePath === workspacePath) {
    globalRegistry.setLabels(registry);
    notifySchemaChanged();
  } else {
    globalRegistry.setWorkspaceLabelLayer(workspacePath, registry);
  }
}

export async function deleteWorkspaceTrackerSchema(
  workspacePath: string,
  type: string,
  options?: { allowBuiltinOverride?: boolean },
): Promise<{ deleted: boolean; filePath?: string }> {
  if (!workspacePath) throw new Error('workspacePath is required');
  if (!type) throw new Error('type is required');
  if (globalRegistry.isBuiltin(type) && !options?.allowBuiltinOverride) {
    throw new Error(`Cannot delete built-in tracker type '${type}'`);
  }

  const filePath = await findWorkspaceSchemaFileByType(workspacePath, type);
  if (!filePath) return { deleted: false };

  await fsPromises.unlink(filePath);
  refreshWorkspaceSchemasIfCurrent(workspacePath);

  return { deleted: true, filePath };
}
