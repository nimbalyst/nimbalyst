/**
 * Proposal changes to the label vocabulary, and the one data change that uses
 * it (`apply-label`, a label on many pages at once).
 *
 * Vocabulary changes (`add-label`, `add-property`, `add-label-property`,
 * `add-broader`, `extend-range`) are schema: the browser cannot write the
 * registry, so an agent applies an accepted change through the merge-by-id
 * `tracker_define_type({ labels })` and marks it applied. A change is
 * satisfied as soon as the registry already says what it asks. `apply-label`
 * and `split-label` are data the web console writes, once the labels they
 * name exist.
 */
import type { ClaimPropertyExtension, FieldPropertyDefinition, LabelDefinition, PredicateDefinition } from '../../../../tracker-schema/src/browser';
import type { KnowledgeGraph } from './ontologyKnowledge';
import { type OntologyRecordLike } from './ontologyRecords';
import type { ChangePlan, PlanEnv } from './ontologyProposals';
/**
 * The change shapes the wiki update skill drafts (its "Ontology proposals"
 * table). Keep the two in step: a field renamed here is a change the agent's
 * proposals stop satisfying.
 */
export type LabelChange = 
/** `label`: a full label registry entry. */
{
    type: 'add-label';
    label: LabelDefinition;
}
/**
 * `property`: a field property entry for `storage: field`, or a predicate
 * entry for `storage: claim`, whose `range` / `options` / `facet` ride in
 * `claimProperty`. `labelIds`: labels that should list it.
 */
 | {
    type: 'add-property';
    storage: 'field' | 'claim';
    property: FieldPropertyDefinition | (Partial<PredicateDefinition> & {
        id: string;
        label: string;
    });
    claimProperty?: ClaimPropertyExtension;
    labelIds?: string[];
} | {
    type: 'add-label-property';
    labelId: string;
    propertyId: string;
    expects?: {
        min?: number;
        max?: number;
    };
} | {
    type: 'add-broader';
    labelId: string;
    broaderId: string;
}
/** `labelIds` are added to the property's `range`. */
 | {
    type: 'extend-range';
    propertyId: string;
    labelIds: string[];
} | {
    type: 'apply-label';
    labelId: string;
    pageIds: string[];
}
/** `into`: the new labels; `pageIds`: new label id -> the pages that move to it. */
 | {
    type: 'split-label';
    labelId: string;
    into: LabelDefinition[];
    pageIds: Record<string, string[]>;
};
export type LabelChangeType = LabelChange['type'];
export declare const LABEL_CHANGE_TYPES: readonly LabelChangeType[];
export declare const LABEL_SCHEMA_CHANGE_TYPES: readonly LabelChangeType[];
/** Null when the change is well formed; otherwise what is missing. Undefined for a type this module does not own. */
export declare function labelChangeProblem(change: Record<string, unknown>): string | null | undefined;
export declare function planLabelChange<T extends OntologyRecordLike>(change: LabelChange & {
    appliedAt?: string;
}, graph: KnowledgeGraph<T>, env: PlanEnv): ChangePlan<T>;
/**
 * Open proposals (proposed or accepted) touching a label: a change naming it,
 * or a request raised from one of its health checks.
 */
export declare function proposalsTouchingLabel<T extends OntologyRecordLike>(proposals: readonly T[], labelId: string): T[];
