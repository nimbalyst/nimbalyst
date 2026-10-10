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
import type { LabelRegistry } from '@nimbalyst/tracker-schema';
import { propertyRange } from '../ontologyLabels';

export const MIN_ZONE_SIZE = 3;
export const OTHER_ZONE = '~other';

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

class Groups {
  private parent = new Map<string, string>();
  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string): void {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

export function buildZones(registry: LabelRegistry, types: readonly ZoneInputType[], links: readonly ZoneInputLink[]): {
  zones: TypeMapZone[];
  zoneOf: Map<string, string>;
} {
  const ids = new Set(types.map((type) => type.id));
  const groups = new Groups();
  for (const id of ids) groups.find(id);
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  const declared = new Set<string>();

  for (const label of registry.labels) {
    if (!ids.has(label.id)) continue;
    for (const property of label.properties ?? []) {
      for (const target of propertyRange(registry, property)) {
        if (!ids.has(target) || target === label.id) continue;
        groups.union(label.id, target);
        declared.add(label.id).add(target);
        bump(label.id);
        bump(target);
      }
    }
  }
  for (const label of registry.labels) {
    if (!ids.has(label.id) || declared.has(label.id)) continue;
    const parent = (label.broader ?? []).find((id) => ids.has(id));
    if (parent) {
      groups.union(parent, label.id);
      declared.add(label.id);
    }
  }

  const size = () => {
    const sizes = new Map<string, number>();
    for (const id of ids) sizes.set(groups.find(id), (sizes.get(groups.find(id)) ?? 0) + 1);
    return sizes;
  };
  // Attach loose labels by usage until nothing moves.
  const loose = new Set([...ids].filter((id) => !declared.has(id)));
  for (let moved = true; moved;) {
    moved = false;
    const sizes = size();
    for (const id of [...loose].sort()) {
      const weight = new Map<string, number>();
      for (const link of links) {
        const other = link.from === id ? link.to : link.to === id ? link.from : null;
        if (!other || other === id || loose.has(other)) continue;
        const group = groups.find(other);
        weight.set(group, (weight.get(group) ?? 0) + link.statements);
      }
      const best = [...weight].sort((a, b) => b[1] - a[1] || (sizes.get(b[0]) ?? 0) - (sizes.get(a[0]) ?? 0) || a[0].localeCompare(b[0]))[0];
      if (best && best[1] > 0) {
        groups.union(best[0], id);
        loose.delete(id);
        moved = true;
      }
    }
  }

  const members = new Map<string, string[]>();
  for (const type of types) {
    const group = groups.find(type.id);
    members.set(group, [...(members.get(group) ?? []), type.id]);
  }
  const byId = new Map(types.map((type) => [type.id, type]));
  const pages = (list: readonly string[]) => list.reduce((sum, id) => sum + (byId.get(id)?.count ?? 0), 0);
  const zones: TypeMapZone[] = [];
  const pooled: string[] = [];
  for (const list of members.values()) {
    if (list.length < MIN_ZONE_SIZE) {
      pooled.push(...list);
      continue;
    }
    const hub = [...list].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (byId.get(b)?.count ?? 0) - (byId.get(a)?.count ?? 0) || a.localeCompare(b))[0]!;
    zones.push({ id: hub, name: `${byId.get(hub)?.plural ?? hub} and related types`, hub, typeIds: list });
  }
  zones.sort((a, b) => pages(b.typeIds) - pages(a.typeIds) || b.typeIds.length - a.typeIds.length || a.id.localeCompare(b.id));
  if (pooled.length) {
    zones.push({ id: OTHER_ZONE, name: zones.length ? 'Other types' : 'All types', hub: null, typeIds: pooled });
  }
  const zoneOf = new Map<string, string>();
  for (const zone of zones) for (const id of zone.typeIds) zoneOf.set(id, zone.id);
  return { zones, zoneOf };
}
