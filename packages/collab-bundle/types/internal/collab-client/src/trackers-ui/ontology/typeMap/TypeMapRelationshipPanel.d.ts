import type { OntologyInspectorWriter } from '../OntologyInspector';
import { type TypeMapModel, type TypeMapRelationship, type TypeMapType } from '../ontologyLabelMap';
import type { MapSelection } from './TypeMapCanvas';
export interface RelationshipActions {
    /** Opens a page by item id; omitted leaves page names as plain text. */
    onOpenPage?: (id: string) => void;
    /** Files proposal requests; null hides every proposal and review action. */
    writer?: OntologyInspectorWriter | null;
}
interface Props extends RelationshipActions {
    model: TypeMapModel;
    relationship: TypeMapRelationship;
    typeById: ReadonlyMap<string, TypeMapType>;
    zoneTone: ReadonlyMap<string, number>;
    onCenter: (selection: NonNullable<MapSelection>) => void;
}
/** A sentence about the shape of the statements, when one fact stands out. */
export declare function relationshipNote(relationship: TypeMapRelationship, from: TypeMapType | undefined, to: TypeMapType | undefined, rangeNames: string): string | null;
export declare function TypeMapRelationshipPanel({ model, relationship, typeById, zoneTone, onCenter, onOpenPage, writer }: Props): import("react").JSX.Element;
export {};
