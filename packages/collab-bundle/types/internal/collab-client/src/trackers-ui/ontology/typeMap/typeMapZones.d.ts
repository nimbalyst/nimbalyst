/**
 * Which domain each type sits in on the map, derived from the vocabulary so no
 * pack or domain name is hard-coded:
 *
 * 1. Labels joined by a declared relationship (a label lists a property whose
 *    range names the other) share a zone. A vocabulary pack declares its
 *    relationships among its own labels, so a pack becomes one zone.
 * 2. A label with no declared relationship joins its broader label's zone.
 * 3. A label still alone joins the zone it shares the most statements with,
 *    repeated until nothing moves (a format linked only to a technology
 *    follows the technology).
 * 4. Groups smaller than {@link MIN_ZONE_SIZE} are pooled into one last zone.
 *
 * A zone is named after its hub: the label with the most declared
 * relationships inside it (then the most pages).
 */
import type { LabelRegistry } from '../../../../../tracker-schema/src/browser';
export declare const MIN_ZONE_SIZE = 3;
export declare const OTHER_ZONE = "~other";
export interface TypeMapZone {
    id: string;
    name: string;
    /** The label the zone is named after; null for the pooled zone. */
    hub: string | null;
    typeIds: string[];
}
export interface ZoneInputType {
    id: string;
    plural: string;
    count: number;
}
export interface ZoneInputLink {
    from: string;
    to: string;
    statements: number;
}
export declare function buildZones(registry: LabelRegistry, types: readonly ZoneInputType[], links: readonly ZoneInputLink[]): {
    zones: TypeMapZone[];
    zoneOf: Map<string, string>;
};
