/**
 * Which named relations a link between two typed pages may carry.
 *
 * A relation is a registry predicate whose object is another page
 * (`valueShape: 'entity'`). The link hover card offers the predicates whose
 * `subjectKinds` admit the linking page's type and whose `objectKinds`, when
 * declared, admit the linked page's type, both resolved through `extends`.
 * Everything else stays a plain link.
 */
import { type PredicateDefinition } from './predicateRegistry.js';
export interface PageRelationOption {
    predicateId: string;
    /** How the statement reads from the linking page. */
    label: string;
    /** How it reads from the linked page; the label itself when symmetric or undeclared. */
    inverseLabel: string;
    direction: PredicateDefinition['direction'];
}
/** The inverse name a relation shows on the page it points at. */
export declare function relationInverseLabel(predicate: Pick<PredicateDefinition, 'label' | 'inverseLabel' | 'direction'>): string;
export declare function relationsForPair(predicates: Iterable<PredicateDefinition>, sourceType: string, targetType: string, baseOf?: (type: string) => string | undefined): PageRelationOption[];
