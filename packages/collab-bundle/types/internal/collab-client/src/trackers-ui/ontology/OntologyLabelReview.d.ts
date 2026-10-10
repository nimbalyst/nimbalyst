import type { LabelRegistry, PredicateDefinition, TrackerDataModel } from '../../../../tracker-schema/src/browser';
import { type HealthItem } from './ontologyKnowledge';
import { type OntologyRecordLike } from './ontologyRecords';
import type { OntologyInspectorWriter } from './OntologyInspector';
import './ontologyInspector.css';
import './ontologyTypes.css';
export interface OntologyLabelReviewProps {
    labelId: string;
    /** Health items about this label (`labelIds` includes it). */
    health: ReadonlyArray<HealthItem<OntologyRecordLike>>;
    types: readonly TrackerDataModel[];
    predicates?: readonly PredicateDefinition[] | null;
    labels?: LabelRegistry | null;
    records: readonly OntologyRecordLike[];
    /** Null for a reader who may not write. */
    writer: OntologyInspectorWriter | null;
    onOpenItem?: (itemId: string) => void;
}
export declare function OntologyLabelReview({ labelId, health, types, predicates, labels, records, writer, onOpenItem }: OntologyLabelReviewProps): import("react").JSX.Element;
