import type { LabelRegistry, PredicateDefinition, TrackerDataModel } from '../../../../tracker-schema/src/browser';
import { type OntologyRecordLike } from './ontologyRecords';
import type { TrackerCommandFn } from './ontologyWriter';
import './ontologyInspector.css';
/** Kept for hosts that pass it; the concept map moved to the wiki's Types page. */
export type OntologyInspectorView = 'track';
export interface OntologyInspectorWriter {
    command: TrackerCommandFn;
    /** The project new proposals are created in. */
    workspace: string;
    actor: string | null;
}
export interface OntologyInspectorProps {
    types: readonly TrackerDataModel[];
    /** Null when the host cannot read the room's registry; predicates are then keyed off claim ids. */
    predicates?: readonly PredicateDefinition[] | null;
    /** The room's label registry; empty reads through the kind stand-in. */
    labels?: LabelRegistry | null;
    records: readonly OntologyRecordLike[];
    /** Null for a reader who may not write: proposals can be read but not created or decided. */
    writer: OntologyInspectorWriter | null;
    /** False until the room's first snapshot arrives, so an empty room is not mistaken for one still loading. */
    loaded?: boolean;
    onOpenItem?: (itemId: string) => void;
    initialView?: OntologyInspectorView;
    /** Opens the wiki's Types section, where labels are browsed and reviewed. */
    onOpenTypes?: () => void;
    /** Injected in tests; the inspector otherwise judges stale facts against the time it opened. */
    now?: number;
}
export declare function OntologyInspector({ types, predicates, labels, records, writer, loaded, onOpenItem, onOpenTypes, now: fixedNow }: OntologyInspectorProps): import("react").JSX.Element;
