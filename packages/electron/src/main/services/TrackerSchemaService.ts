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
  type TrackerDataModel,
  type TrackerSchemaRole,
  getRoleField,
  getFieldByRole,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { materializeTrackerTypeDef, materializeTrackerTypeDefs } from './tracker/trackerTypeDefStore';

// ---------------------------------------------------------------------------
// Service State
// ---------------------------------------------------------------------------

let initialized = false;
let watcher: ReturnType<typeof chokidar.watch> | null = null;
let currentWorkspacePath: string | null = null;

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

  try {
    if (!fs.existsSync(trackersDir)) return;

    const files = fs.readdirSync(trackersDir).filter(
      f => f.endsWith('.yaml') || f.endsWith('.yml')
    );

    const loaded: TrackerDataModel[] = [];
    for (const file of files) {
      try {
        const filePath = path.join(trackersDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const model = parseTrackerYAML(content);
        globalRegistry.register(model); // workspace schemas are not builtin
        loaded.push(model);
        // console.log(`[TrackerSchemaService] Loaded workspace schema: ${model.type}`);
      } catch (err) {
        console.error(`[TrackerSchemaService] Failed to load ${file}:`, err);
      }
    }
    // Mirror the loaded models into the DB so the database is the local source
    // of truth for offline consumers (the `nim` CLI). Best-effort; never blocks
    // schema loading. YAML stays the init/import format for git-backed projects.
    if (loaded.length) void materializeTrackerTypeDefs(workspacePath, loaded);
  } catch (err) {
    // Directory doesn't exist or can't be read -- that's fine
  }
}

function reloadWorkspaceSchema(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const model = parseTrackerYAML(content);
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
    files = fs.readdirSync(trackersDir).filter(
      f => f.endsWith('.yaml') || f.endsWith('.yml'),
    );
  } catch {
    return;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(trackersDir, file), 'utf-8');
      const model = parseTrackerYAML(content);
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
      const model = parseTrackerYAML(content);
      if (model.type === type) return filePath;
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
  options?: { fileName?: string; overwrite?: boolean },
): Promise<{ model: TrackerDataModel; filePath: string; backupPath?: string }> {
  if (!workspacePath) throw new Error('workspacePath is required');

  const yamlContent = typeof schema === 'string' ? schema : serializeTrackerYAML(schema);
  const model = parseTrackerYAML(yamlContent);

  if (globalRegistry.isBuiltin(model.type)) {
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

export async function deleteWorkspaceTrackerSchema(
  workspacePath: string,
  type: string,
): Promise<{ deleted: boolean; filePath?: string }> {
  if (!workspacePath) throw new Error('workspacePath is required');
  if (!type) throw new Error('type is required');
  if (globalRegistry.isBuiltin(type)) {
    throw new Error(`Cannot delete built-in tracker type '${type}'`);
  }

  const filePath = await findWorkspaceSchemaFileByType(workspacePath, type);
  if (!filePath) return { deleted: false };

  await fsPromises.unlink(filePath);
  refreshWorkspaceSchemasIfCurrent(workspacePath);

  return { deleted: true, filePath };
}
