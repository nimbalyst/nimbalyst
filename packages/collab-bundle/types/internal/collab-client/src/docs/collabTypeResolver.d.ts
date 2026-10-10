import type { TrackerDataModel } from '../../../tracker-schema/src/browser';
import type { CollabTypeTreeResolver } from './collabTree';
export interface CollabTypeRegistry {
    get(type: string): TrackerDataModel | undefined;
    getListed(): TrackerDataModel[];
}
/** A tracker item as the resolver reads it; each host maps its own records. */
export interface CollabTypeResolverRecord {
    id: string;
    typeId: string;
    /** The display title, already trimmed. */
    title: string;
    issueNumber?: number | null;
    archived?: boolean;
    /**
     * Exists only on this machine: never shared, like a frontmatter projection
     * of a local file. Kept out of the team section even when its type is a
     * team type, because it is not team data.
     */
    localOnly?: boolean;
}
/** Which Pages section a resolver serves. */
export type CollabTypeLane = 'team' | 'personal';
/**
 * Each section offers and names only its own types. A team placement of a
 * personal type would reach teammates who do not have that schema, and their
 * tree would skip it as unknown; a team type placed in Personal pages would
 * file shared items under a section that claims to be private.
 */
export declare function buildCollabTypeResolver(registry: CollabTypeRegistry, records: Iterable<CollabTypeResolverRecord>, lane?: CollabTypeLane, 
/**
 * Types whose file did not load, with the reason. A broken type is not in the
 * registry, so without this it and its pages would vanish from the tree; with
 * it they show, named by type id and marked broken. A registered type is never
 * broken: a bad edit to a loaded type keeps the last good definition.
 */
brokenTypes?: ReadonlyMap<string, string>): CollabTypeTreeResolver;
