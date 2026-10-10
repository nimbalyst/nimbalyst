import type { OntologyInspectorWriter } from './OntologyInspector';
import type { TypeMapModel, TypeMapRelationship } from './ontologyLabelMap';
import { type MapSelection } from './typeMap/TypeMapCanvas';
import './typeMap/typeMap.css';
export interface OntologyTypeMapProps {
    model: TypeMapModel;
    /** Opens a label's type page (its table); `newTab` when Cmd/Ctrl was held. */
    onOpenLabel: (id: string, options?: {
        newTab: boolean;
    }) => void;
    /** Opens a page by item id. */
    onOpenPage?: (id: string) => void;
    /** Opens the pages that carry no label; omitted hides the entry. */
    onOpenUnlabeled?: () => void;
    /** Files proposal requests; null or omitted (the public wiki, viewers) hides those actions. */
    writer?: OntologyInspectorWriter | null;
    /** False drops the inspector: the map takes the width and a click on a type opens it. */
    inspector?: boolean;
}
/** The type and relationship ids a selection lights: itself and its neighbourhood. */
export declare function litIds(selection: MapSelection, relationships: readonly TypeMapRelationship[]): Set<string>;
export declare function OntologyTypeMap({ model, onOpenLabel, onOpenPage, onOpenUnlabeled, writer, inspector }: OntologyTypeMapProps): import("react").JSX.Element;
