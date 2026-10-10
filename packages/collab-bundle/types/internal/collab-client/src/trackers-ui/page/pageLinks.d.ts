import { type TrackerPageLink } from '../../../../runtime/src/plugins/TrackerPlugin/models/trackerRelationships';
export type { TrackerPageLink };
export interface PageLinksSource {
    /**
     * Every link of the page, both directions. Null when they cannot be read
     * right now, which keeps whatever the section already shows.
     */
    linksFor(itemId: string): Promise<TrackerPageLink[] | null>;
}
export interface LinkedPage {
    itemId: string;
    title: string;
    typeId: string;
    sentences: string[];
}
export interface TrackerLinkGroup {
    label: string;
    pages: LinkedPage[];
}
/** Group links by the label they read under from this page; mentions sort last. */
export declare function groupTrackerPageLinks(links: TrackerPageLink[], itemType: string | undefined): TrackerLinkGroup[];
