/**
 * The label checks that judge the vocabulary itself, and so only mean
 * something once the room has a registry: sparse properties, statements whose
 * subject has no label listing their predicate (informational), labels listing
 * ids nothing declares, broader cycles, and labels that look like duplicates.
 * Loaded with the type pages and the inspector, not with every tracker surface.
 */
import { type LabelRegistry } from '../../../../tracker-schema/src/browser';
import { type HealthItem } from './ontologyKnowledge';
import { type LabelHealthInput } from './ontologyLabelHealth';
import { type OntologyRecordLike } from './ontologyRecords';
export declare function computeLabelSchemaHealth<T extends OntologyRecordLike>(input: LabelHealthInput<T>): Array<HealthItem<T>>;
/** Each distinct cycle in the `broader` graph, as label ids in order. */
export declare function labelCycles(registry: LabelRegistry): string[][];
/** Label pairs with the same name (singular or plural) or descriptions sharing most of their words. */
export declare function duplicateLabels(registry: LabelRegistry): Array<[string, string]>;
