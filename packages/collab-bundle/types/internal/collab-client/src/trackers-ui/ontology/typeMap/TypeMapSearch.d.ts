import type { TypeMapRelationship, TypeMapType } from '../ontologyLabelMap';
import type { MapSelection } from './TypeMapCanvas';
export interface TypeMapSearchProps {
    types: readonly TypeMapType[];
    relationships: readonly TypeMapRelationship[];
    typeById: ReadonlyMap<string, TypeMapType>;
    onPick: (selection: NonNullable<MapSelection>) => void;
}
export declare function TypeMapSearch({ types, relationships, typeById, onPick }: TypeMapSearchProps): import("react").JSX.Element;
