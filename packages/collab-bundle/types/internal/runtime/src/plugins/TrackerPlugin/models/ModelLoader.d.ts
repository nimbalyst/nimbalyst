/**
 * Model loader for built-in and custom tracker definitions
 */
import { type DerivedTrackerTypeDeclaration, type TrackerDataModel, type TrackerTypeDeclaration, type TrackerTypeLookup } from '../../../../../tracker-schema/src/browser';
/**
 * Raw YAML strings for every bundled builtin tracker type, in load order.
 * Keep this list in sync with the files under ./builtins.
 */
export declare const BUILTIN_TRACKER_YAML: ReadonlyArray<{
    type: string;
    yaml: string;
}>;
/**
 * Parse every bundled builtin YAML into resolved models. Throws if any builtin
 * YAML is malformed or its declared `type` doesn't match its filename, so a bad
 * builtin fails fast (in CI and at startup) instead of silently dropping a type.
 */
export declare function parseBuiltinTrackers(): TrackerDataModel[];
/**
 * True for the `<type>.patch.yaml` shape, which carries only a delta from a
 * builtin seed and legitimately has no `displayName`.
 */
export declare function isTrackerPatchFileName(fileName: string): boolean;
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
export declare function resolveTrackerSchemaFileContent(fileName: string, content: string): TrackerDataModel;
/**
 * Parse a workspace schema file WITHOUT resolving a derived type (`extends`):
 * a patch is resolved against its seed, a full model is returned as is, and a
 * derived declaration is returned as declared. This is the form to register,
 * since the registry re-resolves a declaration whenever its base changes and
 * tolerates a base that has not loaded yet.
 */
export declare function parseTrackerSchemaFileDeclaration(fileName: string, content: string): TrackerTypeDeclaration;
/**
 * Resolve a declaration to a full model. A derived type resolves against
 * `lookup` (the registry by default); throws when it cannot, so a caller never
 * holds a model that silently lacks its base's fields.
 */
/** Resolve a base against the registry: its declared form first, so chains resolve. */
export declare const registryTrackerTypeLookup: TrackerTypeLookup;
export declare function resolveTrackerTypeDeclaration(declared: TrackerTypeDeclaration, lookup?: TrackerTypeLookup): TrackerDataModel;
/**
 * The declaration to keep for a resolved model: `declared` when the caller has
 * it, else one recovered by diffing against the base the registry holds now.
 * Undefined for a plain type, or a subtype whose base is not registered.
 *
 * Every persisted and outgoing form of a subtype goes through this, so a
 * resolved copy is never stored or registered as if it were the declaration.
 */
export declare function declarationForResolvedModel(model: TrackerDataModel, declared?: DerivedTrackerTypeDeclaration): DerivedTrackerTypeDeclaration | undefined;
/**
 * Resolve a set of declarations that may extend one another, in any order.
 * Unresolvable derived types are dropped (and logged): a type whose base is
 * missing has no complete model to offer.
 */
export declare function resolveTrackerTypeDeclarations(declarations: readonly TrackerTypeDeclaration[], fallback?: TrackerTypeLookup): TrackerDataModel[];
/**
 * Load all built-in tracker definitions
 */
export declare function loadBuiltinTrackers(): void;
/**
 * Load a custom tracker definition from YAML string
 */
export declare function loadCustomTracker(yamlString: string): void;
/**
 * Load custom trackers from a directory (for workspace-specific trackers)
 * This would be called by the Electron main process and passed to the renderer
 */
export declare function loadCustomTrackersFromDirectory(directoryPath: string, fs: any): Promise<void>;
/**
 * ModelLoader singleton for accessing tracker models
 */
export declare class ModelLoader {
    private static instance;
    private constructor();
    static getInstance(): ModelLoader;
    getModel(type: string): Promise<TrackerDataModel>;
    getAllModels(): TrackerDataModel[];
}
