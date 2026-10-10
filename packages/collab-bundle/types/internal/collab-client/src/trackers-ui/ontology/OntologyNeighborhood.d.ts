/**
 * The small neighborhood diagram at the top of a category's detail page in
 * "What we track": the category and the categories it links to directly. The
 * project-wide map is the label type map in the wiki (`OntologyTypeMap`).
 */
import { type DomainModel } from './ontologyDomain';
import type { OpenCategory } from './OntologyParts';
/** The category and its direct neighbors, for the top of a detail page. */
export declare function OntologyNeighborhood({ model, categoryId, onOpen, onOpenGap }: {
    model: DomainModel;
    categoryId: string;
    onOpen: OpenCategory;
    onOpenGap: (gapId: string) => void;
}): import("react").JSX.Element | null;
