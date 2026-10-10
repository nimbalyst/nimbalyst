import type { TrackerRecord } from '../../../runtime/src/core/TrackerRecord';
import type { CollabTypeTreeResolver } from '../docs/collabTree';
import { type CollabTypeLane, type CollabTypeRegistry } from '../docs/collabTypeResolver';
export declare function browserTypeResolver(records: readonly TrackerRecord[], registry: CollabTypeRegistry, lane?: CollabTypeLane): CollabTypeTreeResolver;
/** Rebuilt when the room's records or the registry's types change. */
export declare function useBrowserTypeResolver(lane?: CollabTypeLane): CollabTypeTreeResolver;
