/**
 * The panel beside the map: an overview with nothing selected, a type's panel,
 * or a relationship's (`TypeMapRelationshipPanel`).
 */
import type { TypeMapModel, TypeMapRelationship, TypeMapType } from '../ontologyLabelMap';
import type { MapSelection } from './TypeMapCanvas';
import { type RelationshipActions } from './TypeMapRelationshipPanel';
export interface TypeMapInspectorProps extends RelationshipActions {
    model: TypeMapModel;
    typeById: ReadonlyMap<string, TypeMapType>;
    /** The relationships the map currently shows (toggles applied). */
    relationships: readonly TypeMapRelationship[];
    zoneTone: ReadonlyMap<string, number>;
    selection: MapSelection;
    /** Select and fly to. */
    onPick: (selection: NonNullable<MapSelection>) => void;
    onCenter: (selection: NonNullable<MapSelection>) => void;
    onOpenLabel: (id: string) => void;
    onOpenUnlabeled?: () => void;
}
export declare function TypeMapInspector(props: TypeMapInspectorProps): import("react").JSX.Element;
