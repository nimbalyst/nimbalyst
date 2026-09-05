import type { ProjectGraphSnapshot } from "../types";
import { withRecordedSessionLinks } from "./sessionLinks";
import {
  createAreaRegistry,
  ruleMatches,
  normalizedTags,
  type AreaRule,
} from "./areaRegistry";
import { eventsForNode } from "./events";
import type {
  PrototypeArea,
  PrototypeMembership,
  PrototypeModel,
} from "./contracts";

export interface PrototypeModelOptions {
  source?: "live" | "sample";
  areaNames?: Record<string, string>;
  coverage?: string[];
  areaRegistry?: AreaRule[];
  periodCoverage?: PrototypeModel["periodCoverage"];
}

/** Rules group evidence; they never manufacture edges or completion claims. */
export function buildPrototypeModel(
  snapshot: ProjectGraphSnapshot,
  options: PrototypeModelOptions = {}
): PrototypeModel {
  snapshot = withRecordedSessionLinks(snapshot);
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const registry = options.areaRegistry ?? createAreaRegistry(snapshot);
  const active = registry.filter((r) => !r.hidden && r.id !== "unassigned");
  const memberships = new Map<string, PrototypeMembership[]>();
  for (const node of snapshot.nodes) {
    const tags = normalizedTags(node);
    const matches = active.flatMap((rule) => {
      const basis = ruleMatches(rule, node, tags);
      return basis ? [{ areaId: rule.id, basis }] : [];
    });
    if (matches.length) memberships.set(node.id, matches);
  }
  // Inherit exactly one hop from direct rules, never from other inherited nodes.
  const direct = new Map(memberships);
  const inherited = new Map<string, Map<string, PrototypeMembership>>();
  for (const edge of snapshot.edges) {
    if (direct.has(edge.sourceId) && direct.has(edge.targetId)) continue;
    for (const [id, neighbor] of [
      [edge.sourceId, edge.targetId],
      [edge.targetId, edge.sourceId],
    ]) {
      if (direct.has(id) || !nodeById.has(id)) continue;
      const source = direct.get(neighbor);
      if (!source) continue;
      const entries =
        inherited.get(id) ?? new Map<string, PrototypeMembership>();
      for (const m of source)
        if (!entries.has(m.areaId))
          entries.set(m.areaId, {
            areaId: m.areaId,
            basis: `Via ${edge.type}: ${
              nodeById.get(neighbor)?.label ?? neighbor
            }${edge.provenance ? ` (${edge.provenance.kind})` : ""}`,
          });
      inherited.set(id, entries);
    }
  }
  for (const [id, entries] of inherited)
    memberships.set(id, [...entries.values()]);
  const areaNodeIds = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (!memberships.has(node.id))
      memberships.set(node.id, [
        {
          areaId: "unassigned",
          basis: "Outside the configured area rules and their direct neighbors",
        },
      ]);
    for (const m of memberships.get(node.id)!) {
      const ids = areaNodeIds.get(m.areaId) ?? [];
      ids.push(node.id);
      areaNodeIds.set(m.areaId, ids);
    }
  }
  const unassigned = registry.find((r) => r.id === "unassigned") ?? {
    id: "unassigned",
    label: "Unassigned",
    slot: Math.max(-1, ...registry.map((r) => r.slot)) + 1,
  };
  const areas: PrototypeArea[] = [...active, unassigned]
    .filter((r) => options.areaRegistry !== undefined || areaNodeIds.has(r.id))
    .sort((a, b) => a.slot - b.slot)
    .map((r) => ({
      id: r.id,
      label: options.areaNames?.[r.id]?.trim() || r.label,
      slot: r.slot,
      nodeIds: areaNodeIds.get(r.id) ?? [],
      basis:
        r.id === "unassigned"
          ? "Outside configured areas; records remain searchable"
          : [
              r.tags?.length ? `Tags: ${r.tags.join(", ")}` : "",
              r.anchorIds?.length ? "Selected record anchors" : "",
              r.paths?.length ? `Paths: ${r.paths.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; ") + "; includes direct neighbors",
    }));
  const source = options.source ?? "live";
  return {
    snapshot,
    nodeById,
    areas,
    memberships,
    source,
    events: snapshot.nodes.flatMap((n) =>
      eventsForNode(n, snapshot.generatedAt)
    ),
    periodCoverage: options.periodCoverage,
    coverage: [
      source === "sample"
        ? "Illustrative sample records; no claims about your actual project."
        : "Counts describe the indexed sources and scope. Source-specific coverage and freshness are listed below.",
      "Areas use stable, editable tag, path or record-anchor rules plus one-hop neighbors. Areas overlap; their counts are not additive.",
      "Dated events use native timestamps. Last activity is one observation, never a work interval. Missing history is unknown.",
      "Relations retain their recorded or derived basis. A link does not prove completion, release or verification.",
      ...(options.coverage ?? []),
    ],
  };
}
