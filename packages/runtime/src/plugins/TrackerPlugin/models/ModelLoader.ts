/**
 * Model loader for built-in and custom tracker definitions
 */

import { parseTrackerYAML, parseTrackerTypeYAML } from '@nimbalyst/tracker-schema';
import {
  deriveTrackerTypeDeclaration,
  globalRegistry,
  isDerivedTrackerTypeDeclaration,
  resolveTrackerTypeInheritance,
  type DerivedTrackerTypeDeclaration,
  type TrackerDataModel,
  type TrackerTypeDeclaration,
  type TrackerTypeLookup,
} from '@nimbalyst/tracker-schema';
import { parseTrackerSchemaPatchYAML, resolveTrackerSchemaPatch } from '@nimbalyst/tracker-schema';

// Built-in tracker definitions are authored as YAML under ./builtins and bundled
// as raw strings via Vite's `?raw` loader (see runtime/src/env.d.ts). This is the
// single source of truth for builtins and the resolvable seed that workspace and
// synced overrides (patches) layer onto. Both the Electron renderer/main and the
// mobile Capacitor build compile runtime source through Vite, which inlines these
// strings at build time, so no separate asset copy is needed.
import planYaml from './builtins/plan.yaml?raw';
import decisionYaml from './builtins/decision.yaml?raw';
import bugYaml from './builtins/bug.yaml?raw';
import taskYaml from './builtins/task.yaml?raw';
import ideaYaml from './builtins/idea.yaml?raw';
import milestoneYaml from './builtins/milestone.yaml?raw';
import releaseYaml from './builtins/release.yaml?raw';
// Builtin knowledge evidence kinds, available independently of custom graph types.
import sourceYaml from './builtins/source.yaml?raw';
import captureYaml from './builtins/capture.yaml?raw';
import citationYaml from './builtins/citation.yaml?raw';
// import featureYaml from './builtins/feature.yaml?raw';
// import automationYaml from './builtins/automation.yaml?raw';

/**
 * Raw YAML strings for every bundled builtin tracker type, in load order.
 * Keep this list in sync with the files under ./builtins.
 */
export const BUILTIN_TRACKER_YAML: ReadonlyArray<{ type: string; yaml: string }> = [
  { type: 'plan', yaml: planYaml },
  { type: 'decision', yaml: decisionYaml },
  { type: 'bug', yaml: bugYaml },
  { type: 'task', yaml: taskYaml },
  { type: 'idea', yaml: ideaYaml },
  { type: 'milestone', yaml: milestoneYaml },
  { type: 'release', yaml: releaseYaml },
  // Load order matters for readability only, but it follows the evidence chain:
  // a capture points at a source, a citation points at a capture.
  { type: 'source', yaml: sourceYaml },
  { type: 'capture', yaml: captureYaml },
  { type: 'citation', yaml: citationYaml },
  // { type: 'feature', yaml: featureYaml },
  // { type: 'automation', yaml: automationYaml },
];

/**
 * Parse every bundled builtin YAML into resolved models. Throws if any builtin
 * YAML is malformed or its declared `type` doesn't match its filename, so a bad
 * builtin fails fast (in CI and at startup) instead of silently dropping a type.
 */
export function parseBuiltinTrackers(): TrackerDataModel[] {
  return BUILTIN_TRACKER_YAML.map(({ type, yaml }) => {
    const model = parseTrackerYAML(yaml);
    if (model.type !== type) {
      throw new Error(
        `Builtin tracker YAML for '${type}' declares mismatched type '${model.type}'`
      );
    }
    return model;
  });
}


/**
 * True for the `<type>.patch.yaml` shape, which carries only a delta from a
 * builtin seed and legitimately has no `displayName`.
 */
export function isTrackerPatchFileName(fileName: string): boolean {
  return /\.patch\.ya?ml$/i.test(fileName);
}

/**
 * Resolve a workspace schema file's content to a fully-resolved model,
 * whichever of the two on-disk shapes it is.
 *
 * Every reader of `.nimbalyst/trackers/*.yaml` must go through this. Running
 * the full-model parser over a patch throws `Missing required field:
 * displayName` — which is how the renderer silently dropped every builtin
 * override on each workspace load, and how the Settings "Edit schema override"
 * button silently did nothing (NIM-3065).
 *
 * Throws on a patch whose target type has no seed, so a stray patch surfaces
 * instead of registering a broken model.
 */
export function resolveTrackerSchemaFileContent(
  fileName: string,
  content: string,
): TrackerDataModel {
  return resolveTrackerTypeDeclaration(parseTrackerSchemaFileDeclaration(fileName, content));
}

/**
 * Parse a workspace schema file WITHOUT resolving a derived type (`extends`):
 * a patch is resolved against its seed, a full model is returned as is, and a
 * derived declaration is returned as declared. This is the form to register,
 * since the registry re-resolves a declaration whenever its base changes and
 * tolerates a base that has not loaded yet.
 */
export function parseTrackerSchemaFileDeclaration(
  fileName: string,
  content: string,
): TrackerTypeDeclaration {
  if (!isTrackerPatchFileName(fileName)) return parseTrackerTypeYAML(content);
  const patch = parseTrackerSchemaPatchYAML(content);
  const seed = globalRegistry.getBuiltinModel(patch.type) ?? globalRegistry.get(patch.type);
  if (!seed) throw new Error(`Tracker schema patch targets unknown type '${patch.type}'`);
  return resolveTrackerSchemaPatch(seed, patch);
}

/**
 * Resolve a declaration to a full model. A derived type resolves against
 * `lookup` (the registry by default); throws when it cannot, so a caller never
 * holds a model that silently lacks its base's fields.
 */
/** Resolve a base against the registry: its declared form first, so chains resolve. */
export const registryTrackerTypeLookup: TrackerTypeLookup = (type) =>
  globalRegistry.getDeclaredModel(type) ?? globalRegistry.get(type);

export function resolveTrackerTypeDeclaration(
  declared: TrackerTypeDeclaration,
  lookup: TrackerTypeLookup = registryTrackerTypeLookup,
): TrackerDataModel {
  if (!isDerivedTrackerTypeDeclaration(declared)) return declared;
  const { model, errors } = resolveTrackerTypeInheritance(declared, lookup);
  if (!model) throw new Error(errors.map((error) => error.message).join('; '));
  return model;
}

/**
 * The declaration to keep for a resolved model: `declared` when the caller has
 * it, else one recovered by diffing against the base the registry holds now.
 * Undefined for a plain type, or a subtype whose base is not registered.
 *
 * Every persisted and outgoing form of a subtype goes through this, so a
 * resolved copy is never stored or registered as if it were the declaration.
 */
export function declarationForResolvedModel(
  model: TrackerDataModel,
  declared?: DerivedTrackerTypeDeclaration,
): DerivedTrackerTypeDeclaration | undefined {
  if (declared) return declared;
  if (!model.extends) return undefined;
  const base = globalRegistry.get(model.extends);
  return base ? deriveTrackerTypeDeclaration(model, base) : undefined;
}

/**
 * Resolve a set of declarations that may extend one another, in any order.
 * Unresolvable derived types are dropped (and logged): a type whose base is
 * missing has no complete model to offer.
 */
export function resolveTrackerTypeDeclarations(
  declarations: readonly TrackerTypeDeclaration[],
  fallback: TrackerTypeLookup = (type) => globalRegistry.getBuiltinModel(type),
): TrackerDataModel[] {
  const byType = new Map(declarations.map((declared) => [declared.type, declared]));
  const lookup: TrackerTypeLookup = (type) => byType.get(type) ?? fallback(type);
  const resolved: TrackerDataModel[] = [];
  for (const declared of declarations) {
    try {
      resolved.push(resolveTrackerTypeDeclaration(declared, lookup));
    } catch (error) {
      console.error(`[TrackerPlugin] Cannot resolve tracker type '${declared.type}':`, error);
    }
  }
  return resolved;
}

/**
 * Load all built-in tracker definitions
 */
export function loadBuiltinTrackers(): void {
  // console.log('[TrackerPlugin] Loading built-in trackers...');

  for (const { type, yaml } of BUILTIN_TRACKER_YAML) {
    try {
      const model = parseTrackerYAML(yaml);
      if (model.type !== type) {
        throw new Error(`declares mismatched type '${model.type}'`);
      }
      globalRegistry.register(model, true);
      // console.log(`[TrackerPlugin] Loaded built-in tracker: ${model.type}`);
    } catch (error) {
      console.error(`[TrackerPlugin] Failed to load built-in tracker '${type}':`, error);
    }
  }

  console.log(`[TrackerPlugin] Loaded ${globalRegistry.getAll().length} built-in trackers`);
}

/**
 * Load a custom tracker definition from YAML string
 */
export function loadCustomTracker(yamlString: string): void {
  // Derived types (`extends`) register as their declared form; the registry
  // resolves them against the base and re-resolves when the base changes.
  const model = parseTrackerTypeYAML(yamlString);
  globalRegistry.register(model);
  console.log(`[TrackerPlugin] Loaded custom tracker: ${model.type}`);
}

/**
 * Load custom trackers from a directory (for workspace-specific trackers)
 * This would be called by the Electron main process and passed to the renderer
 */
export async function loadCustomTrackersFromDirectory(
  directoryPath: string,
  fs: any // File system interface
): Promise<void> {
  // This function would be implemented in the Electron layer
  // to read YAML files from .nimbalyst/trackers/ directory
  console.log(`[TrackerPlugin] Loading custom trackers from: ${directoryPath}`);
}

/**
 * ModelLoader singleton for accessing tracker models
 */
export class ModelLoader {
  private static instance: ModelLoader;

  private constructor() {
    // Initialize built-in trackers on construction
    loadBuiltinTrackers();
  }

  static getInstance(): ModelLoader {
    if (!ModelLoader.instance) {
      ModelLoader.instance = new ModelLoader();
    }
    return ModelLoader.instance;
  }

  async getModel(type: string): Promise<TrackerDataModel> {
    const model = globalRegistry.get(type);
    if (!model) {
      throw new Error(`Tracker model not found for type: ${type}`);
    }
    return model;
  }

  getAllModels(): TrackerDataModel[] {
    return globalRegistry.getAll();
  }
}
