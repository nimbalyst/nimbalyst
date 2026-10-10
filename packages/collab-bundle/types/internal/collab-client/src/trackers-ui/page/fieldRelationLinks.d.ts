/**
 * A typed page's relationship-field links, both directions, read straight from
 * the tracker records a browser holds: the field half of the desktop's local
 * relationship index (`trackerPageLinks.ts`), in the same row shape, so the
 * Links section groups them the same way. Body links come from elsewhere (the
 * server's page links index on the web).
 */
import { type FieldDefinition } from '../../../../tracker-schema/src/browser';
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import type { TrackerPageLink } from './pageLinks';
type FieldDefs = (typeId: string) => ReadonlyArray<Pick<FieldDefinition, 'name' | 'type'>>;
export declare function fieldRelationLinks(itemId: string, records: Iterable<TrackerRecord>, fieldDefs?: FieldDefs): TrackerPageLink[];
export {};
