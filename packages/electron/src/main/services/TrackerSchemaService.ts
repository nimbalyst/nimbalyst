/**
 * TrackerSchemaService -- main-process authority for tracker schemas.
 *
 * Loads built-in schemas and workspace YAML schemas, watches for changes,
 * and exposes schemas to the renderer and MCP via IPC.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import chokidar from 'chokidar';
import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import {
  isTrackerSchemaFile,
  shouldIgnoreTrackerWatchPath,
} from './trackerSchemaWatchUtils';
import {
  globalRegistry,
  loadBuiltinTrackers,
  parseTrackerYAML,
  serializeTrackerYAML,
  parseTrackerSchemaPatchYAML,
  serializeTrackerSchemaPatchYAML,
  resolveTrackerSchemaPatch,
  type TrackerDataModel,
  type TrackerSchemaPatch,
  type TrackerSchemaRole,
  getRoleField,
  getFieldByRole,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  materializeTrackerTypeDef,
  materializeTrackerTypeDefs,
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

// ---------------------------------------------------------------------------
// Service State
// ---------------------------------------------------------------------------

let initialized = false;
let watcher: ReturnType<typeof chokidar.watch> | null = null;
let currentWorkspacePath: string | null = null;

// ---------------------------------------------------------------------------
// Patch overrides (delta files)
// ---------------------------------------------------------------------------

/**
 * Workspace overrides come in two on-disk shapes under `.nimbalyst/trackers`:
 *  - a full schema `<type>.yaml` (custom types, or a wholesale builtin override)
 *  - a delta `<type>.patch.yaml` (the sanctioned builtin-override representation)
 * A patch is resolved against the live builtin seed at load, so upstream builtin
 * improvements flow through and git diffs stay small. See the configurable-
 * builtin-tracker-types plan.
 */
function isTrackerPatchFileName(fileName: string): boolean {
  return /\.patch\.ya?ml$/i.test(fileName);
}

/** Deterministic patch file name for a type's builtin override. */
function patchFileNameForType(type: string): string {
  return `${type}.patch.yaml`;
}

/**
 * Resolve a schema file's content to a fully-resolved model. Patch files are
 * resolved against the builtin seed (falling back to any already-registered base
 * for a custom type); full-schema files are parsed directly. Throws on a patch
 * whose target type has no seed, so a stray patch surfaces instead of silently
 * registering a broken model.
 */
function resolveSchemaModelFromContent(fileName: string, content: string): TrackerDataModel {
  if (isTrackerPatchFileName(fileName)) {
    const patch = parseTrackerSchemaPatchYAML(content);
    const seed = globalRegistry.getBuiltinModel(patch.type) ?? globalRegistry.get(patch.type);
    if (!seed) {
      throw new Error(`Tracker schema patch targets unknown type '${patch.type}'`);
    }
    return resolveTrackerSchemaPatch(seed, patch);
  }
  return parseTrackerYAML(content);
}

/** Read the `type` a schema file targets without fully resolving a patch. */
function readSchemaFileType(fileName: string, content: string): string | undefined {
  try {
    if (isTrackerPatchFileName(fileName)) {
      return parseTrackerSchemaPatchYAML(content).type;
    }
    return parseTrackerYAML(content).type;
  } catch {
    return undefined;
  }
}

/**
 * Order schema files so full-schema definitions load before patch files. A patch
 * targeting a custom base type must resolve after that base is registered; builtin
 * patches are unaffected (their seed is always present).
 */
function orderSchemaFilesForLoad(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const pa = isTrackerPatchFileName(a) ? 1 : 0;
    const pb = isTrackerPatchFileName(b) ? 1 : 0;
    return pa - pb;
  });
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
    registerIpcHandlers();
    initialized = true;
  }

  if (workspacePath && workspacePath !== currentWorkspacePath) {
    currentWorkspacePath = workspacePath;
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
  currentWorkspacePath = workspacePath;

  if (workspacePath) {
    loadWorkspaceSchemas(workspacePath); // clears old workspace schemas first
    watchSchemaDirectory(workspacePath);
  } else {
    globalRegistry.clearWorkspaceSchemas();
    stopWatcher();
  }
}

// ---------------------------------------------------------------------------
// Schema Loading
// ---------------------------------------------------------------------------

function loadWorkspaceSchemas(workspacePath: string): void {
  // Clear any schemas from a previous workspace before loading new ones
  globalRegistry.clearWorkspaceSchemas();

  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');

  const loaded: TrackerDataModel[] = [];
  let shouldReconcileYamlMirror = false;
  try {
    if (fs.existsSync(trackersDir)) {
      const files = orderSchemaFilesForLoad(fs.readdirSync(trackersDir).filter(
        f => f.endsWith('.yaml') || f.endsWith('.yml')
      ));
      shouldReconcileYamlMirror = true;

      for (const file of files) {
        try {
          const filePath = path.join(trackersDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const model = resolveSchemaModelFromContent(file, content);
          globalRegistry.register(model); // workspace schemas are not builtin
          loaded.push(model);
          // console.log(`[TrackerSchemaService] Loaded workspace schema: ${model.type}`);
        } catch (err) {
          console.error(`[TrackerSchemaService] Failed to load ${file}:`, err);
        }
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

  // Mirror the loaded models into the DB so the database is the local source of
  // truth for offline consumers (the `nim` CLI), then reconcile: tombstone any
  // YAML-sourced type whose file was deleted on disk so the mirror stays an
  // accurate reflection of the YAML set. Best-effort; never blocks schema
  // loading. YAML stays the init/import format for git-backed projects.
  void (async () => {
    try {
      if (shouldReconcileYamlMirror) {
        if (loaded.length) await materializeTrackerTypeDefs(workspacePath, loaded);
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
 * YAML-sourced rows are skipped: the on-disk YAML was already registered from
 * source by loadWorkspaceSchemas and is authoritative; overwriting it with the
 * (possibly drifted) mirror copy would be wrong.
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
  for (const def of defs) {
    if (!def?.type) continue;
    // The on-disk YAML is authoritative for yaml-sourced types and is already
    // registered; never clobber it with the mirror copy.
    if (def.source === 'yaml') continue;
    let model: TrackerDataModel | null = null;
    try {
      // `model` is JSON TEXT on SQLite but may be a parsed object on PGLite;
      // parseSyncedTrackerSchemaModel wants a JSON string, so normalize.
      const raw: unknown = def.model;
      const modelJson = typeof raw === 'string' ? raw : JSON.stringify(raw);
      model = parseSyncedTrackerSchemaModel(def.type, modelJson) ?? null;
    } catch {
      model = null;
    }
    if (!model) continue;
    globalRegistry.register(model);
    registered++;
  }
  if (registered > 0) notifySchemaChanged();
  return registered;
}

function reloadWorkspaceSchema(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const model = resolveSchemaModelFromContent(path.basename(filePath), content);
    globalRegistry.register(model);
    if (currentWorkspacePath) void materializeTrackerTypeDef(currentWorkspacePath, model);
    // console.log(`[TrackerSchemaService] Reloaded schema: ${model.type}`);
    notifySchemaChanged();
  } catch (err) {
    console.error(`[TrackerSchemaService] Failed to reload ${filePath}:`, err);
  }
}

function handleSchemaFileDeleted(filePath: string): void {
  // We don't know which type this file defined, so reload all workspace schemas
  // by clearing and re-reading the directory
  if (currentWorkspacePath) {
    globalRegistry.clearWorkspaceSchemas();
    loadWorkspaceSchemas(currentWorkspacePath);
    notifySchemaChanged();
  }
}

// ---------------------------------------------------------------------------
// File Watcher
// ---------------------------------------------------------------------------

function watchSchemaDirectory(workspacePath: string): void {
  stopWatcher();

  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');

  // Only watch if directory exists
  if (!fs.existsSync(trackersDir)) return;

  watcher = chokidar.watch(trackersDir, {
    // Ignore dotfiles inside the watched directory, but do not ignore the
    // parent `.nimbalyst` segment itself or chokidar drops every event.
    ignored: (candidatePath: string) => shouldIgnoreTrackerWatchPath(trackersDir, candidatePath),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
    depth: 0, // only watch the directory itself, not subdirs
  });

  watcher
    .on('change', (filePath: string) => {
      if (isTrackerSchemaFile(filePath)) {
        reloadWorkspaceSchema(filePath);
      }
    })
    .on('add', (filePath: string) => {
      if (isTrackerSchemaFile(filePath)) {
        reloadWorkspaceSchema(filePath);
      }
    })
    .on('unlink', (filePath: string) => {
      if (isTrackerSchemaFile(filePath)) {
        handleSchemaFileDeleted(filePath);
      }
    })
    .on('error', (error: unknown) => {
      console.error('[TrackerSchemaService] Watcher error:', error);
    });
}

function stopWatcher(): void {
  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  safeHandle('tracker-schema:get-all', async () => {
    return globalRegistry.getAll().map(serializeModel);
  });

  safeHandle('tracker-schema:get', async (_event, type: string) => {
    const model = globalRegistry.get(type);
    return model ? serializeModel(model) : null;
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

  safeHandle('tracker-schema:reset-override', async (_event, workspacePath: string, type: string) => {
    return resetWorkspaceTrackerSchemaOverride(workspacePath, type);
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function notifySchemaChanged(): void {
  const schemas = globalRegistry.getAll().map(serializeModel);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tracker-schema:changed', schemas);
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
 * Reads the `.nimbalyst/trackers` YAML dir directly and registers each model.
 * Additive and idempotent (`register()` overwrites by type); it never clears, so
 * it cannot wipe the active workspace's schemas when called for a different one.
 * Builtins are assumed loaded by `initTrackerSchemaService` at startup.
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

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(trackersDir, file), 'utf-8');
      const model = resolveSchemaModelFromContent(file, content);
      globalRegistry.register(model); // workspace schemas are not builtin
    } catch (err) {
      console.error(`[TrackerSchemaService] ensureWorkspaceTrackerSchemasLoaded failed for ${file}:`, err);
    }
  }
}

export function isBuiltinTrackerSchema(type: string): boolean {
  return globalRegistry.isBuiltin(type);
}

export function getTrackerRoleField(type: string, role: TrackerSchemaRole): string | undefined {
  const model = globalRegistry.get(type);
  if (!model) return undefined;
  return getRoleField(model, role);
}

async function findWorkspaceSchemaFileByType(workspacePath: string, type: string): Promise<string | null> {
  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  let files: string[];
  try {
    files = await fsPromises.readdir(trackersDir);
  } catch {
    return null;
  }

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const filePath = path.join(trackersDir, file);
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      // Match on the declared target type for both full-schema and patch files,
      // so an override located in `<type>.patch.yaml` is found for reset/backup.
      if (readSchemaFileType(file, content) === type) return filePath;
    } catch {
      // Ignore invalid YAML here; it will be surfaced when that file is loaded.
    }
  }

  return null;
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

function refreshWorkspaceSchemasIfCurrent(workspacePath: string): void {
  // Also load when currentWorkspacePath is null -- no workspace has been set yet
  // (happens when upsertWorkspaceTrackerSchema is called before any workspace window opens).
  if (currentWorkspacePath !== null && workspacePath !== currentWorkspacePath) return;
  currentWorkspacePath = workspacePath;
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

export async function upsertWorkspaceTrackerSchema(
  workspacePath: string,
  schema: TrackerDataModel | string,
  options?: { fileName?: string; overwrite?: boolean; allowBuiltinOverride?: boolean },
): Promise<{ model: TrackerDataModel; filePath: string; backupPath?: string }> {
  if (!workspacePath) throw new Error('workspacePath is required');

  const yamlContent = typeof schema === 'string' ? schema : serializeTrackerYAML(schema);
  const model = parseTrackerYAML(yamlContent);

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
  let backupPath: string | undefined;
  if (existingFilePath) {
    if (!options?.overwrite) {
      throw new TrackerTypeExistsError(model.type, existingFilePath);
    }
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
  options?: { overwrite?: boolean },
): Promise<{ model: TrackerDataModel; filePath: string; backupPath?: string }> {
  if (!workspacePath) throw new Error('workspacePath is required');
  if (!patch?.type) throw new Error('patch.type is required');

  const seed = globalRegistry.getBuiltinModel(patch.type) ?? globalRegistry.get(patch.type);
  if (!seed) throw new Error(`Cannot patch unknown tracker type '${patch.type}'`);

  // Resolve now to validate the patch and produce the resolved model. Throws on a
  // malformed patch (e.g. adding a field without a type) before anything is written.
  const model = resolveTrackerSchemaPatch(seed, patch);

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
    const content = await fsPromises.readFile(existing, 'utf-8');
    return { model: parseTrackerYAML(content), filePath: existing, created: false };
  }

  const model = globalRegistry.get(type);
  if (!model) throw new Error(`Unknown tracker type '${type}'`);

  const result = await upsertWorkspaceTrackerSchema(workspacePath, model, {
    fileName: `${type}.yaml`,
    allowBuiltinOverride: true,
  });
  return { model: result.model, filePath: result.filePath, created: true };
}

export async function resetWorkspaceTrackerSchemaOverride(
  workspacePath: string,
  type: string,
): Promise<{ reset: boolean; filePath?: string }> {
  const result = await deleteWorkspaceTrackerSchema(workspacePath, type, {
    allowBuiltinOverride: true,
  });
  if (result.deleted) {
    // Tombstone the DB mirror so the reset PROPAGATES: a shared/hybrid override
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

interface WorkspaceSchemaDiskRead {
  models: TrackerDataModel[];
  canReconcile: boolean;
}

/**
 * Read and parse the on-disk YAML schema models for a workspace. Best-effort:
 * unreadable directories and unparseable files are skipped (logged) rather than
 * treated as an empty set, mirroring the safeguard in loadWorkspaceSchemas so a
 * transient read error never masquerades as "all YAML deleted."
 */
function readWorkspaceSchemaModelsFromDisk(workspacePath: string): WorkspaceSchemaDiskRead {
  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  const models: TrackerDataModel[] = [];
  let files: string[];
  try {
    if (!fs.existsSync(trackersDir)) return { models, canReconcile: true };
    files = orderSchemaFilesForLoad(fs.readdirSync(trackersDir).filter(
      f => f.endsWith('.yaml') || f.endsWith('.yml'),
    ));
  } catch (err) {
    console.error(`[TrackerSchemaService] readWorkspaceSchemaModelsFromDisk failed for ${trackersDir}:`, err);
    return { models, canReconcile: false };
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(trackersDir, file), 'utf-8');
      models.push(resolveSchemaModelFromContent(file, content));
    } catch (err) {
      console.error(`[TrackerSchemaService] Failed to parse ${file} for drift check:`, err);
    }
  }
  return { models, canReconcile: true };
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
  if (yamlModels.length) await materializeTrackerTypeDefs(workspacePath, yamlModels);
  await reconcileYamlTrackerTypeDefs(workspacePath, yamlModels.map(m => m.type));
}

function parseSyncedTrackerSchemaModel(type: string, modelJson: string): TrackerDataModel | null {
  try {
    const parsed = JSON.parse(modelJson) as Partial<TrackerDataModel>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.type !== type) return null;
    if (!Array.isArray(parsed.fields)) return null;
    return parsed as TrackerDataModel;
  } catch {
    return null;
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

  const model = def.model === null
    ? null
    : parseSyncedTrackerSchemaModel(def.type, def.model);
  if (def.model !== null && !model) {
    return { applied: false, reason: 'invalid' };
  }

  const result = await applyRemoteTrackerSchemaDef(workspacePath, def);
  if (!result.applied) return result;

  if (currentWorkspacePath === workspacePath) {
    if (result.deleted) {
      globalRegistry.clearWorkspaceSchema(def.type);
    } else if (model) {
      globalRegistry.register(model);
    }
    notifySchemaChanged();
  }

  return result;
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
