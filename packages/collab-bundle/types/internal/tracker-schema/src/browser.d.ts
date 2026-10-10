/**
 * The package root for a browser bundle: everything `index.ts` exports except
 * the authoring-only exports no browser surface calls on first paint -- the
 * tracker schema and predicate registry change classifiers, the label
 * registry's merge, patch and classifier, and YAML serialization and the
 * registry-file parsers.
 *
 * Why a second barrel: the collab bundle's `trackers-ui` entry re-exports the
 * package root wholesale (through `@nimbalyst/collab-client/trackers`), so
 * every root export is retained in its eager graph whether anything calls it
 * or not. The bundle resolves the bare `@nimbalyst/tracker-schema` here
 * instead; desktop, the collab server and the published package keep the full
 * root. Browser code that needs an authoring export imports its module by
 * subpath (`@nimbalyst/tracker-schema/labelRegistryAuthoring`), which keeps it
 * in whichever lazy chunk asked for it.
 *
 * `validateLabelRegistry` is the exception: the schema lane decodes a
 * `__labels__` row with it, and the browser store decodes on connect.
 */
export * from './TrackerDataModel.js';
export * from './citationLocator.js';
export * from './predicateRegistry.js';
export * from './predicateRelations.js';
export * from './labelRegistry.js';
export * from './labelPropertyQualifiers.js';
export { validateLabelRegistry, type LabelRegistryValidation, type LabelRegistryValidationContext, } from './labelRegistryAuthoring.js';
export * from './claimValues.js';
export { normalizeTrackerSharingModel, parseTrackerTypeYAML, parseTrackerYAML } from './YAMLParser.js';
export * from './schemaPatch.js';
export * from './trackerTypeIdentity.js';
export * from './trackerTypeInheritance.js';
export * from './trackerStatusCategory.js';
export * from './trackerCoreContext.js';
export * from './singleValuedField.js';
