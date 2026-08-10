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
  diffTrackerSchema,
  decodeTrackerSchemaPayload,
  encodeTrackerSchemaPatchPayload,
  type TrackerDataModel,
  type TrackerSchemaPatch,
  type TrackerSchemaRole,
  getRoleField,
  getFieldByRole,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  materializeTrackerTypeDef,
  materializeTrackerTypeDefs,
  materializeYamlTrackerTypeDef,
  materializeYamlTrackerTypeDefs,
  markTrackerTypeDefProjected,
  listRetractedTeamOwnedTrackerTypes,
  listUnprojectedTeamOwnedTrackerTypes,
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
  installTrackerSchemaScopeProvider,
  runWithTrackerSchemaWorkspace,
} from './tracker/trackerSchemaScope';
import {
  getWindowIdForWindow,
  resolveActiveWorkspacePathForWindowId,
} from '../window/windowState';

// ---------------------------------------------------------------------------
// Service State
// ---------------------------------------------------------------------------

let initialized = false;
let watcher: ReturnType<typeof chokidar.watch> | null = null;
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
  setCurrentWorkspacePath(workspacePath);

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
  for (const def of defs) {
    if (!def?.type) continue;
    // The on-disk YAML is authoritative only for a type the team does not share,
    // and it is already registered; never clobber it with the mirror copy.
    if (def.source === 'yaml' && def.sync_id == null) continue;
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
  if (isSelfWrittenSchemaFile(filePath)) return; // our own write-back, not a user edit
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const model = resolveSchemaModelFromContent(path.basename(filePath), content);
    globalRegistry.register(model);
    // Yaml-aware mirror write: for a team-owned type this either no-ops (the file
    // matches the shared definition) or queues the user's edit for push (#1178).
    if (currentWorkspacePath) void materializeYamlTrackerTypeDef(currentWorkspacePath, model);
    // console.log(`[TrackerSchemaService] Reloaded schema: ${model.type}`);
    notifySchemaChanged();
  } catch (err) {
    console.error(`[TrackerSchemaService] Failed to reload ${filePath}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Write-back (shared definition -> YAML file)
// ---------------------------------------------------------------------------

/**
 * Paths this service is writing itself. The chokidar watcher cannot tell a
 * write-back from a user edit, and treating our own write as an edit would queue
 * a pointless push (and, with two peers, an echo loop). Entries are cleared once
 * the watcher has had a chance to fire.
 */
const selfWrittenSchemaFiles = new Set<string>();

function isSelfWrittenSchemaFile(filePath: string): boolean {
  return selfWrittenSchemaFiles.has(path.resolve(filePath));
}

/**
 * Retire the local YAML file for a type the team has deleted, so the retraction
 * actually takes effect on this machine instead of the file re-registering the
 * dead definition on the next load. The content is preserved as a `.bak`
 * sibling, which the loader ignores (it only reads `.yaml` / `.yml`).
 */
async function retireLocalSchemaFile(workspacePath: string, type: string): Promise<void> {
  const filePath = await findWorkspaceSchemaFileByType(workspacePath, type);
  if (!filePath) return;
  try {
    selfWrittenSchemaFiles.add(path.resolve(filePath));
    await fsPromises.rename(filePath, `${filePath}.${Date.now()}.bak`);
  } catch (err) {
    console.error(`[TrackerSchemaService] failed to retire ${type} schema file:`, err);
  }
}

/**
 * Write every team-owned schema this workspace has not yet projected onto its
 * YAML dir, overwriting any local file for that type.
 *
 * This is the half of "shared definition wins" that makes the file useful rather
 * than merely ignored: once projected, an edit to it is unambiguous and gets
 * pushed to the team. Before projection there is no baseline, so the file can
 * only be disregarded — which is right for correctness but leaves the user with
 * a file that silently does nothing (#1178).
 *
 * Idempotent: a row is projected once, then `synced_model` keeps it out.
 */
async function projectUnprojectedSharedSchemas(workspacePath: string): Promise<void> {
  const pending = await listUnprojectedTeamOwnedTrackerTypes(workspacePath);
  for (const row of pending) {
    const raw: unknown = row.model;
    const model = parseSyncedTrackerSchemaModel(
      row.type,
      typeof raw === 'string' ? raw : JSON.stringify(raw),
    );
    if (!model) continue;
    // Builtin overrides project as a delta for the same reason they travel as
    // one: the local file keeps picking up shipped builtin fields.
    await writeBackSharedSchema(workspacePath, model, globalRegistry.isBuiltin(row.type));
  }
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

/**
 * Project a shared tracker schema onto this workspace's YAML file, so the file
 * is a faithful copy of what the team shares and a later hand edit is
 * unambiguously a local change to push. Best-effort: a workspace whose schema
 * dir cannot be written still runs off the DB mirror.
 */
async function writeBackSharedSchema(
  workspacePath: string,
  model: TrackerDataModel,
  asPatch = false,
): Promise<void> {
  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  // A builtin override projects as a DELTA file, so the local copy keeps
  // resolving against this app's builtin as it evolves -- the same reason the
  // payload travels as a delta.
  const seed = asPatch ? globalRegistry.getBuiltinModel(model.type) : undefined;
  const fileName = seed ? patchFileNameForType(model.type) : `${model.type}.yaml`;
  const filePath = path.resolve(path.join(trackersDir, fileName));
  try {
    await fsPromises.mkdir(trackersDir, { recursive: true });
    selfWrittenSchemaFiles.add(filePath);
    const content = seed
      ? serializeTrackerSchemaPatchYAML(diffTrackerSchema(seed, model))
      : serializeTrackerYAML(model);
    await fsPromises.writeFile(filePath, content, 'utf-8');
    // Record what a RE-READ of the file yields, not the model we were handed:
    // serialize->parse normalizes (defaults, tag support, key order), and
    // recording the pre-serialization model would make the very next load look
    // like a local edit -- every peer would push an echo of what it just
    // received.
    const projected = resolveSchemaModelFromContent(path.basename(filePath), content);
    await markTrackerTypeDefProjected(workspacePath, model.type, JSON.stringify(projected));
    // A full-copy override left over from before this type went delta would be
    // loaded alongside the patch; retire it so one file defines one type.
    const stale = await findWorkspaceSchemaFileByType(workspacePath, model.type);
    if (stale && path.resolve(stale) !== filePath) {
      selfWrittenSchemaFiles.add(path.resolve(stale));
      await fsPromises.rename(stale, `${stale}.${Date.now()}.bak`);
    }
  } catch (err) {
    console.error(`[TrackerSchemaService] write-back failed for ${model.type}:`, err);
  } finally {
    // `awaitWriteFinish` delays the watcher event past the write itself.
    setTimeout(() => selfWrittenSchemaFiles.delete(filePath), 2000).unref?.();
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
      if (model) byType.set(def.type, model);
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
  const models: TrackerDataModel[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(trackersDir, file), 'utf-8');
      const model = resolveSchemaModelFromContent(file, content);
      if (isActive) {
        globalRegistry.register(model); // workspace schemas are not builtin
      } else {
        models.push(model);
      }
    } catch (err) {
      console.error(`[TrackerSchemaService] ensureWorkspaceTrackerSchemasLoaded failed for ${file}:`, err);
    }
  }

  // Replace rather than merge: the full YAML dir was just re-read, so a type
  // whose file was deleted must not linger in the cached layer.
  if (!isActive) globalRegistry.setWorkspaceLayer(workspacePath, models);
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
  if (yamlModels.length) await materializeYamlTrackerTypeDefs(workspacePath, yamlModels);
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
): { model: TrackerDataModel; isPatch: boolean } | null {
  const decoded = decodeTrackerSchemaPayload(type, modelJson);
  if (!decoded) return null;
  if (decoded.kind === 'model') return { model: decoded.model, isPatch: false };

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
  const result = await applyRemoteTrackerSchemaDef(
    workspacePath,
    model ? { ...def, model: JSON.stringify(model) } : def,
  );
  if (!result.applied) return result;

  // Project the team's definition onto the workspace's YAML file. Without this
  // the file keeps whatever it had, and there is no baseline to tell a later
  // hand edit from a leftover -- so the edit could never be pushed (#1178).
  if (model && !result.deleted) {
    await writeBackSharedSchema(workspacePath, model, resolved?.isPatch ?? false);
  }

  if (result.deleted) {
    await retireLocalSchemaFile(workspacePath, def.type);
  }

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
