import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { CollabTypeTreeResolver } from './collabTree';

type ResolvedItem = { itemId: string; title: string; sortKey: number | string };

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
export function buildCollabTypeResolver(
  registry: CollabTypeRegistry,
  records: Iterable<CollabTypeResolverRecord>,
  lane: CollabTypeLane = 'team',
  /**
   * Types whose file did not load, with the reason. A broken type is not in the
   * registry, so without this it and its pages would vanish from the tree; with
   * it they show, named by type id and marked broken. A registered type is never
   * broken: a bad edit to a loaded type keeps the last good definition.
   */
  brokenTypes?: ReadonlyMap<string, string>,
): CollabTypeTreeResolver {
  const inLane = (model: TrackerDataModel): boolean =>
    ((model.sharing ?? 'personal') === 'team') === (lane === 'team');
  const laneModel = (typeId: string): TrackerDataModel | undefined => {
    const model = registry.get(typeId);
    return model && inLane(model) ? model : undefined;
  };
  const typeError = (typeId: string): string | null =>
    (registry.get(typeId) ? null : brokenTypes?.get(typeId) ?? null);
  const shown = (typeId: string): boolean => !!laneModel(typeId) || typeError(typeId) !== null;

  const itemsByType = new Map<string, ResolvedItem[]>();
  const itemById = new Map<string, { itemId: string; title: string; typeId: string }>();
  for (const record of records) {
    if (record.archived) continue;
    if (lane === 'team' && record.localOnly) continue;
    const list = itemsByType.get(record.typeId) ?? [];
    list.push({ itemId: record.id, title: record.title, sortKey: record.issueNumber ?? record.title });
    itemsByType.set(record.typeId, list);
    itemById.set(record.id, { itemId: record.id, title: record.title, typeId: record.typeId });
  }
  for (const list of itemsByType.values()) {
    list.sort((left, right) =>
      typeof left.sortKey === 'number' && typeof right.sortKey === 'number'
        ? left.sortKey - right.sortKey
        : String(left.sortKey).localeCompare(String(right.sortKey), undefined, { numeric: true }));
  }

  return {
    typeName: (typeId) => {
      const model = laneModel(typeId);
      if (!model) return typeError(typeId) !== null ? typeId : null;
      return model.displayNamePlural || model.displayName || typeId;
    },
    typeLabel: (typeId) => {
      const model = laneModel(typeId);
      if (!model) return typeError(typeId) !== null ? typeId : null;
      return model.displayName || typeId;
    },
    typeError,
    typeExtends: (typeId) => registry.get(typeId)?.extends ?? null,
    // A placed typed page from the other lane is unknown here, like its type.
    item: (itemId) => {
      const item = itemById.get(itemId);
      return item && shown(item.typeId) ? item : null;
    },
    itemsOfType: (typeId) => (shown(typeId) ? itemsByType.get(typeId) ?? [] : []),
    listedTypes: () => registry.getListed()
      .filter(inLane)
      .map((model) => ({
        typeId: model.type,
        name: model.displayNamePlural || model.displayName || model.type,
        icon: model.icon,
        ...(model.creatable === false ? { creatable: false } : {}),
      })),
  };
}
