/**
 * YAML parser for tracker data model definitions
 */
import type { TrackerDataModel, TrackerSharing } from './TrackerDataModel.js';
import type { DerivedTrackerTypeDeclaration } from './trackerTypeInheritance.js';
import { type PredicateDefinition, type PredicateRegistryValidation } from './predicateRegistry.js';
import type { LabelRegistry } from './labelRegistry.js';
import { type LabelRegistryValidation } from './labelRegistryAuthoring.js';
/** Normalize a parsed/JSON model without requiring a full YAML validation pass. */
export declare function normalizeTrackerSharingModel<T extends TrackerDataModel>(model: T, fallbackSharing?: TrackerSharing): T;
/**
 * Parse a YAML string into a TrackerDataModel
 *
 * Rejects a derived declaration (`extends:`), which has no complete model of
 * its own until it is resolved against its base. Use `parseTrackerTypeYAML`,
 * which handles both shapes.
 */
export declare function parseTrackerYAML(yamlString: string): TrackerDataModel;
/**
 * Parse either tracker type shape: a full model, or a derived declaration that
 * carries `extends` plus only what it overrides or adds.
 *
 * A derived declaration is deliberately NOT resolved here. Resolution needs the
 * base, which the parser has no access to, and storing the declared form is
 * what lets a later base change reach the derived type. See
 * `resolveTrackerTypeInheritance`.
 */
export declare function parseTrackerTypeYAML(yamlString: string): TrackerDataModel | DerivedTrackerTypeDeclaration;
/**
 * Serialize a TrackerDataModel to YAML string
 */
export declare function serializeTrackerYAML(model: TrackerDataModel | DerivedTrackerTypeDeclaration): string;
/**
 * Validate a YAML string without fully parsing
 */
export declare function validateTrackerYAML(yamlString: string): {
    valid: boolean;
    error?: string;
};
/**
 * Parse the LOCAL COPY of the predicate registry (`.nimbalyst/predicates.yaml`).
 *
 * The file is a copy, never the distribution mechanism: per decision 12 the
 * room owns the registry and publishes it like a type definition, and this file
 * is the projection of what arrived, plus the authoring surface for a project
 * that has no room yet.
 *
 * Returns issues rather than throwing, and returns every issue: a registry is
 * authored by hand and a reader who is told about one bad field at a time
 * edits the file once per mistake. A `qualifiers` key left from an earlier
 * registry is an unknown-field warning, not a failure.
 */
export declare function parsePredicateRegistryYAML(yamlString: string): PredicateRegistryValidation;
/**
 * Serialize a registry to the `.nimbalyst/predicates.yaml` shape. Relations
 * carry no qualifiers, so a retired `qualifiers` block an older registry still
 * holds is dropped here rather than written back.
 */
export declare function serializePredicateRegistryYAML(predicates: readonly PredicateDefinition[]): string;
/**
 * Parse the local copy of the label registry (`.nimbalyst/labels.yaml`). An
 * empty file is an empty registry. Cross-registry checks are left to callers
 * that hold the predicate registry.
 */
export declare function parseLabelRegistryYAML(yamlString: string): LabelRegistryValidation;
/** Serialize a registry to the `.nimbalyst/labels.yaml` shape. */
export declare function serializeLabelRegistryYAML(registry: LabelRegistry): string;
