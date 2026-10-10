import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import simpleGit from 'simple-git';
import {
  globalRegistry,
  parseTrackerYAML,
  parseTrackerTypeYAML,
  parseTrackerSchemaFileDeclaration,
  resolveTrackerTypeDeclarations,
  declarationForResolvedModel,
  isDerivedTrackerTypeDeclaration,
  TRACKER_SCHEMA_DECLARED_FORM_KEY,
  type DerivedTrackerTypeDeclaration,
  serializeTrackerYAML,
  ensureTagsSupport,
  parseTrackerSchemaPatchYAML,
  serializeTrackerSchemaPatchYAML,
  resolveTrackerSchemaPatch,
  diffTrackerSchema,
  normalizeTrackerSharingModel,
  resolveTrackerSchemaFileContent,
  isTrackerPatchFileName,
  type TrackerDataModel,
  type TrackerTypeDeclaration,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  listMaterializedTrackerTypeDefs,
  listUnprojectedTeamOwnedTrackerTypes,
  markTrackerTypeDefProjected,
  materializeYamlTrackerTypeDef,
  type TrackerSchemaWithActivity,
} from './trackerTypeDefStore';
import { isTrackerSchemaFile } from '../trackerSchemaWatchUtils';
import { findTeamForWorkspace } from '../TeamService';
import { logger } from '../../utils/logger';

export const GIT_TRACKED_TEAM_SCHEMA_WARNING =
  "This file is tracked by git. The team's copy will overwrite it. Restoring an older version while Nimbalyst is running updates it for everyone.";

const teamNameCache = new Map<string, { expiresAt: number; value: Promise<string> }>();

export async function resolveOwningTeamName(workspacePath: string): Promise<string> {
  const cached = teamNameCache.get(workspacePath);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = findTeamForWorkspace(workspacePath)
    .then((team) => team?.name?.trim() || 'your team')
    .catch(() => 'your team');
  teamNameCache.set(workspacePath, { expiresAt: Date.now() + 30_000, value });
  return value;
}

function lastSchemaEditor(model: TrackerDataModel): string | null {
  const activity = (model as TrackerSchemaWithActivity).activity;
  const identity = activity?.[activity.length - 1]?.authorIdentity;
  if (!identity) return null;
  for (const key of ['displayName', 'email', 'gitName', 'gitEmail']) {
    const value = identity[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function schemaOwnershipNotice(teamName: string, editor: string | null): string {
  return `Shared with ${teamName}. Saving this file updates it for everyone. Last changed by ${editor ?? 'unknown'}.`;
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
export { isTrackerPatchFileName };

/** Deterministic patch file name for a type's builtin override. */
export function patchFileNameForType(type: string): string {
  return `${type}.patch.yaml`;
}

/**
 * Resolve a schema file's content to a fully-resolved model. Patch files are
 * resolved against the builtin seed (falling back to any already-registered base
 * for a custom type); full-schema files are parsed directly. Throws on a patch
 * whose target type has no seed, so a stray patch surfaces instead of silently
 * registering a broken model.
 */
export const resolveSchemaModelFromContent = resolveTrackerSchemaFileContent;

/** The registrable form of a schema file: a derived type stays as declared. */
export const parseSchemaDeclarationFromContent = parseTrackerSchemaFileDeclaration;

/** Read the `type` a schema file targets without fully resolving a patch. */
export function readSchemaFileType(fileName: string, content: string): string | undefined {
  try {
    if (isTrackerPatchFileName(fileName)) {
      return parseTrackerSchemaPatchYAML(content).type;
    }
    return parseTrackerTypeYAML(content).type;
  } catch {
    return undefined;
  }
}

/**
 * Order schema files so full-schema definitions load before patch files. A patch
 * targeting a custom base type must resolve after that base is registered; builtin
 * patches are unaffected (their seed is always present).
 */
export function orderSchemaFilesForLoad(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const pa = isTrackerPatchFileName(a) ? 1 : 0;
    const pb = isTrackerPatchFileName(b) ? 1 : 0;
    return pa - pb;
  });
}

/**
 * Serialize `model` in the on-disk shape `fileName` uses: a `.patch.yaml` name
 * carries the delta against the builtin seed, anything else the full schema.
 */
export function serializeSchemaForFile(fileName: string, model: TrackerDataModel): string {
  const { activity: _activity, ...schemaModel } = model as TrackerSchemaWithActivity;
  const serializable = schemaModel as TrackerDataModel;
  if (!isTrackerPatchFileName(fileName)) return serializeTrackerYAML(serializable);
  const seed = globalRegistry.getBuiltinModel(model.type) ?? globalRegistry.get(model.type);
  if (!seed) throw new Error(`Tracker schema patch targets unknown type '${model.type}'`);
  return serializeTrackerSchemaPatchYAML(diffTrackerSchema(seed, serializable));
}

/**
 * What re-reading `fileName` would yield if it held `model`. Comparisons against
 * a file's model must use this, never the raw model: the serialize->parse round
 * trip normalizes defaults and key order, so a raw model would make the very
 * next read look like a local edit and every peer would echo back what it just
 * received.
 */
export function projectedSchemaFormForFile(fileName: string, model: TrackerDataModel): TrackerDataModel {
  const projected = resolveSchemaModelFromContent(fileName, serializeSchemaForFile(fileName, model));
  const activity = (model as TrackerSchemaWithActivity).activity;
  if (Array.isArray(activity)) (projected as TrackerSchemaWithActivity).activity = [...activity];
  return projected;
}

/** {@link projectedSchemaFormForFile} for a file holding a subtype's declaration. */
function projectedDeclarationForFile(fileName: string, body: string, model: TrackerDataModel): TrackerDataModel {
  let projected: TrackerDataModel;
  try {
    projected = resolveSchemaModelFromContent(fileName, body);
  } catch {
    // Base not registered here yet: the resolved model is the best re-read.
    projected = { ...model };
  }
  const activity = (model as TrackerSchemaWithActivity).activity;
  if (Array.isArray(activity)) (projected as TrackerSchemaWithActivity).activity = [...activity];
  return projected;
}

/**
 * Compare models as the REGISTRY will hold them, not as they happen to arrive.
 *
 * Two normalizations are load-bearing, and skipping either turns an innocent
 * edit into a destructive one — the classifier treats anything it cannot prove
 * safe as destructive, so every spurious difference costs a confirmation:
 *  - the serialize->parse round trip, because a file-sourced model has been
 *    through it and a registry- or patch-sourced one has not;
 *  - `ensureTagsSupport`, which `globalRegistry.register` applies, so the model
 *    in force always carries the injected `tags` field that a freshly parsed
 *    file does not. Without it every hand edit reads as "removed `tags`".
 */
export function normalizedForSchemaComparison(model: TrackerDataModel): TrackerDataModel {
  try {
    // `extends` is set aside for the round trip: the full-model parser rejects
    // it, and a resolved derived model is complete without it.
    const { activity: _activity, extends: base, ...schema } = model as TrackerSchemaWithActivity;
    const normalized = ensureTagsSupport(parseTrackerYAML(serializeTrackerYAML(schema as TrackerDataModel)));
    return base ? { ...normalized, extends: base } : normalized;
  } catch {
    return model;
  }
}

export function parseSyncedTrackerSchemaModel(type: string, modelJson: string): TrackerDataModel | null {
  return parseSyncedTrackerSchemaForm(type, modelJson)?.model ?? null;
}

/**
 * A mirror row or payload: the resolved model, plus the subtype declaration
 * stored beside it when there is one. The declaration is never left on the
 * model, which every consumer reads as a plain full model.
 */
export function parseSyncedTrackerSchemaForm(
  type: string,
  modelJson: string,
): { model: TrackerDataModel; declared?: DerivedTrackerTypeDeclaration } | null {
  try {
    const parsed = JSON.parse(modelJson) as Partial<TrackerDataModel> & Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.type !== type) return null;
    if (!Array.isArray(parsed.fields)) return null;
    const { [TRACKER_SCHEMA_DECLARED_FORM_KEY]: sidecar, ...resolved } = parsed;
    const declared = isDerivedTrackerTypeDeclaration(sidecar as DerivedTrackerTypeDeclaration)
      && (sidecar as DerivedTrackerTypeDeclaration).type === type
      ? sidecar as DerivedTrackerTypeDeclaration
      : undefined;
    // Normalize old-client JSON through the same permanent compatibility path
    // as legacy files; any subsequent write emits only the new shape.
    return { model: normalizeTrackerSharingModel(resolved as unknown as TrackerDataModel, 'team'), declared };
  } catch {
    return null;
  }
}

/**
 * Register a resolved model the way the registry must hold it: a subtype as its
 * declaration (given, already in force, or recovered from the base), so it is
 * re-resolved when the base changes instead of frozen at this copy. Only a
 * declaration that fails the inheritance rules falls back to the copy.
 */
export function registerResolvedTrackerSchema(
  model: TrackerDataModel,
  declared?: DerivedTrackerTypeDeclaration,
): void {
  const registered = model.extends ? globalRegistry.getDeclaredModel(model.type) : undefined;
  const declaration = declarationForResolvedModel(
    model,
    declared ?? (registered?.extends === model.extends ? registered : undefined),
  );
  if (declaration) {
    try {
      globalRegistry.register(declaration);
      return;
    } catch (err) {
      logger.main.warn(`[TrackerSchemaService] keeping the resolved copy of '${model.type}':`, err);
    }
  }
  globalRegistry.register(model);
}

export async function findWorkspaceSchemaFileByType(workspacePath: string, type: string): Promise<string | null> {
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

// ---------------------------------------------------------------------------
// Write-back (shared definition -> YAML file)
// ---------------------------------------------------------------------------

/**
 * Paths this service is writing itself. The chokidar watcher cannot tell a
 * write-back from a user edit, and treating our own write as an edit would queue
 * a pointless push (and, with two peers, an echo loop). Entries are cleared once
 * the watcher has had a chance to fire.
 */
const selfWrittenSchemaFiles = new Map<string, ReturnType<typeof setTimeout>>();

/** How long a path stays guarded. `awaitWriteFinish` delays the watcher event. */
const SELF_WRITE_GUARD_MS = 2000;

/**
 * Guard `filePath` against being read back as a user edit. Restarting the timer
 * (rather than stacking a second one) matters both ways: two writes to one path
 * must not have the FIRST expiry unguard the second write, and a guard whose
 * expiry is never scheduled -- as the rename paths used to be -- would ignore
 * every genuine edit to that path for the rest of the session.
 */
function markSelfWrittenSchemaFile(filePath: string): void {
  const key = path.resolve(filePath);
  const pending = selfWrittenSchemaFiles.get(key);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => selfWrittenSchemaFiles.delete(key), SELF_WRITE_GUARD_MS);
  timer.unref?.();
  selfWrittenSchemaFiles.set(key, timer);
}

export function isSelfWrittenSchemaFile(filePath: string): boolean {
  return selfWrittenSchemaFiles.has(path.resolve(filePath));
}

/**
 * Retire the local YAML file for a type the team has deleted, so the retraction
 * actually takes effect on this machine instead of the file re-registering the
 * dead definition on the next load. The content is preserved as a `.bak`
 * sibling, which the loader ignores (it only reads `.yaml` / `.yml`).
 */
export async function retireLocalSchemaFile(workspacePath: string, type: string): Promise<void> {
  const filePath = await findWorkspaceSchemaFileByType(workspacePath, type);
  if (!filePath) return;
  try {
    markSelfWrittenSchemaFile(filePath);
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
export async function projectUnprojectedSharedSchemas(workspacePath: string): Promise<void> {
  const pending = await listUnprojectedTeamOwnedTrackerTypes(workspacePath);
  for (const row of pending) {
    const raw: unknown = row.model;
    const form = parseSyncedTrackerSchemaForm(
      row.type,
      typeof raw === 'string' ? raw : JSON.stringify(raw),
    );
    if (!form) continue;
    // Builtin overrides project as a delta for the same reason they travel as
    // one: the local file keeps picking up shipped builtin fields.
    await writeBackSharedSchema(workspacePath, form.model, globalRegistry.isBuiltin(row.type), form.declared);
  }
}

/** One read-only git subprocess; unlike `status()`, this never performs a `-uall` scan. */
export async function isGitTrackedTrackerSchemaFile(
  workspacePath: string,
  filePath: string,
): Promise<boolean> {
  const relativePath = path.relative(workspacePath, filePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false;
  try {
    const result = await simpleGit(workspacePath).raw([
      '--no-optional-locks',
      'ls-files',
      '--cached',
      '--error-unmatch',
      '--',
      relativePath,
    ]);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function stripGeneratedOwnershipHeader(content: string): string {
  const lines = content.split(/\r?\n/);
  if (!lines[0]?.startsWith('# Shared with ')) return content;
  lines.shift();
  if (lines[0]?.startsWith('# Warning: This file is tracked by git.')) lines.shift();
  if (lines[0] === '') lines.shift();
  return lines.join('\n');
}

async function addSharedSchemaHeader(
  workspacePath: string,
  filePath: string,
  model: TrackerDataModel,
  yamlContent: string,
): Promise<string> {
  const teamName = await resolveOwningTeamName(workspacePath);
  const header = [`# ${schemaOwnershipNotice(teamName, lastSchemaEditor(model))}`];
  if (await isGitTrackedTrackerSchemaFile(workspacePath, filePath)) {
    header.push(`# Warning: ${GIT_TRACKED_TEAM_SCHEMA_WARNING}`);
  }
  return `${header.join('\n')}\n\n${stripGeneratedOwnershipHeader(yamlContent)}`;
}

/** Refresh only the generated ownership comments; the user's YAML body is preserved verbatim. */
export async function refreshSharedSchemaHeader(
  workspacePath: string,
  filePath: string,
  model: TrackerDataModel,
): Promise<void> {
  try {
    const current = await fsPromises.readFile(filePath, 'utf-8');
    const next = await addSharedSchemaHeader(workspacePath, filePath, model, current);
    if (next === current) return;
    markSelfWrittenSchemaFile(filePath);
    await fsPromises.writeFile(filePath, next, 'utf-8');
  } catch (err) {
    logger.main.warn('[TrackerSchemaService] ownership header refresh failed for', model.type, err);
  }
}

/**
 * Persist an explicit agent edit against the shared baseline and refresh its
 * ownership banner. Supplying the baseline here is safe because the tool call,
 * like a watcher event, is an unambiguous post-load intent signal.
 */
export async function writeThroughTeamTrackerSchemaEdit(
  workspacePath: string,
  filePath: string,
  model: TrackerDataModel,
): Promise<void> {
  const fileName = path.basename(filePath);
  await materializeYamlTrackerTypeDef(workspacePath, model, undefined, {
    establishBaseline: (sharedModelJson) => {
      const shared = parseSyncedTrackerSchemaModel(model.type, sharedModelJson);
      return shared ? JSON.stringify(projectedSchemaFormForFile(fileName, shared)) : null;
    },
  });
  registerResolvedTrackerSchema(model);
  await refreshSharedSchemaHeader(workspacePath, filePath, model);
}

/**
 * Project a shared tracker schema onto this workspace's YAML file, so the file
 * is a faithful copy of what the team shares and a later hand edit is
 * unambiguously a local change to push. Best-effort: a workspace whose schema
 * dir cannot be written still runs off the DB mirror.
 */
export async function writeBackSharedSchema(
  workspacePath: string,
  model: TrackerDataModel,
  asPatch = false,
  declared?: DerivedTrackerTypeDeclaration,
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
    markSelfWrittenSchemaFile(filePath);
    // A subtype projects as its declaration, so the file never spells out
    // inherited fields as overrides of its base.
    const registered = !seed && model.extends ? globalRegistry.getDeclaredModel(model.type) : undefined;
    const declaration = seed ? undefined : declarationForResolvedModel(
      model,
      declared ?? (registered?.extends === model.extends ? registered : undefined),
    );
    const body = declaration ? serializeTrackerYAML(declaration) : serializeSchemaForFile(fileName, model);
    const content = await addSharedSchemaHeader(workspacePath, filePath, model, body);
    await fsPromises.writeFile(filePath, content, 'utf-8');
    // Record what a RE-READ of the file yields, not the model we were handed.
    const projected = declaration
      ? projectedDeclarationForFile(fileName, body, model)
      : projectedSchemaFormForFile(fileName, model);
    await markTrackerTypeDefProjected(workspacePath, model.type, JSON.stringify(projected));
    // A full-copy override left over from before this type went delta would be
    // loaded alongside the patch; retire it so one file defines one type.
    const stale = await findWorkspaceSchemaFileByType(workspacePath, model.type);
    if (stale && path.resolve(stale) !== filePath) {
      markSelfWrittenSchemaFile(stale);
      await fsPromises.rename(stale, `${stale}.${Date.now()}.bak`);
    }
  } catch (err) {
    console.error(`[TrackerSchemaService] write-back failed for ${model.type}:`, err);
  }
}

export interface TrackerSchemaOwnershipDetails {
  owner: string;
  lastChangedBy: string | null;
  activity: unknown[];
  fileName?: string;
  gitTracked: boolean;
  ownershipNotice?: string;
  warning?: string;
}

async function workspaceSchemaFilesByType(workspacePath: string): Promise<Map<string, string>> {
  const trackersDir = path.join(workspacePath, '.nimbalyst', 'trackers');
  const result = new Map<string, string>();
  let files: string[];
  try {
    files = await fsPromises.readdir(trackersDir);
  } catch {
    return result;
  }
  for (const fileName of files) {
    if (!isTrackerSchemaFile(fileName)) continue;
    const filePath = path.join(trackersDir, fileName);
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      // Unparseable YAML yields no type. Skip it rather than keying the map on
      // `undefined`: that entry can never be looked up, but its path would still
      // reach the git-tracked probe and be reported against nothing.
      const type = readSchemaFileType(fileName, content);
      if (type) result.set(type, filePath);
    } catch {
      // Invalid files are surfaced by schema loading; ownership stays best-effort.
    }
  }
  return result;
}

async function gitTrackedSchemaPaths(
  workspacePath: string,
  filePaths: string[],
): Promise<Set<string>> {
  const relativePaths = filePaths
    .map((filePath) => path.relative(workspacePath, filePath))
    .filter((filePath) => filePath && !filePath.startsWith('..') && !path.isAbsolute(filePath));
  if (relativePaths.length === 0) return new Set();
  try {
    const raw = await simpleGit(workspacePath).raw([
      '--no-optional-locks', 'ls-files', '--cached', '-z', '--', ...relativePaths,
    ]);
    return new Set(raw.split('\0').filter(Boolean).map((filePath) => path.resolve(workspacePath, filePath)));
  } catch {
    return new Set();
  }
}

/** Ownership metadata shared verbatim by the agent tools and YAML banner. */
export async function getTrackerSchemaOwnershipDetails(
  workspacePath: string,
  models: TrackerDataModel[],
): Promise<Map<string, TrackerSchemaOwnershipDetails>> {
  const [teamName, materialized, filesByType] = await Promise.all([
    models.some((model) => model.sharing === 'team')
      ? resolveOwningTeamName(workspacePath)
      : Promise.resolve('your team'),
    listMaterializedTrackerTypeDefs(workspacePath),
    workspaceSchemaFilesByType(workspacePath),
  ]);
  const storedByType = new Map(materialized.map((row) => [row.type, row.model]));
  const trackedPaths = await gitTrackedSchemaPaths(workspacePath, [...filesByType.values()]);
  const result = new Map<string, TrackerSchemaOwnershipDetails>();

  for (const model of models) {
    let storedModel: TrackerDataModel = model;
    try {
      const stored = storedByType.get(model.type);
      if (stored) storedModel = JSON.parse(stored) as TrackerDataModel;
    } catch {
      // Keep the live registry model if a legacy DB row is malformed.
    }
    const activity = (storedModel as TrackerSchemaWithActivity).activity ?? [];
    const filePath = filesByType.get(model.type);
    const gitTracked = filePath ? trackedPaths.has(path.resolve(filePath)) : false;
    const isTeam = model.sharing === 'team';
    const owner = isTeam
      ? `team:${teamName}`
      : globalRegistry.isBuiltin(model.type) ? 'builtin' : 'personal';
    const editor = lastSchemaEditor(storedModel);
    result.set(model.type, {
      owner,
      lastChangedBy: editor,
      activity,
      fileName: filePath ? path.basename(filePath) : undefined,
      gitTracked,
      ownershipNotice: isTeam ? schemaOwnershipNotice(teamName, editor) : undefined,
      warning: isTeam && gitTracked ? GIT_TRACKED_TEAM_SCHEMA_WARNING : undefined,
    });
  }
  return result;
}

export interface WorkspaceSchemaDiskRead {
  models: TrackerDataModel[];
  canReconcile: boolean;
}

/**
 * Read and parse the on-disk YAML schema models for a workspace. Best-effort:
 * unreadable directories and unparseable files are skipped (logged) rather than
 * treated as an empty set, mirroring the safeguard in loadWorkspaceSchemas so a
 * transient read error never masquerades as "all YAML deleted."
 */
export function readWorkspaceSchemaModelsFromDisk(workspacePath: string): WorkspaceSchemaDiskRead {
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

  const declarations: TrackerTypeDeclaration[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(trackersDir, file), 'utf-8');
      declarations.push(parseSchemaDeclarationFromContent(file, content));
    } catch (err) {
      console.error(`[TrackerSchemaService] Failed to parse ${file} for drift check:`, err);
    }
  }
  models.push(...resolveTrackerTypeDeclarations(declarations));
  return { models, canReconcile: true };
}
