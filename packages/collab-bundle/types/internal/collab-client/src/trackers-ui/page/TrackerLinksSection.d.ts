/**
 * "Links" — the relations and mentions of a page, at the bottom of the page.
 * One collapsed line per relation (incoming relations read under their
 * inverse name, symmetric ones merge both directions); expanding a line shows
 * the sentence that made each link. Hidden when the page has no links.
 */
import React from 'react';
import { type CollabOpenOptions } from '../../core/index';
import { type PageLinksSource } from './pageLinks';
export interface TrackerLinksSectionProps {
    /** Where the links come from; without one the section stays empty. */
    linksSource?: PageLinksSource | null;
    itemId: string;
    itemType?: string;
    /** Bumped by the host after a save that may have re-indexed links. */
    revision?: number;
    onOpenItem?: (itemId: string, options?: CollabOpenOptions) => void;
}
export declare const TrackerLinksSection: React.FC<TrackerLinksSectionProps>;
