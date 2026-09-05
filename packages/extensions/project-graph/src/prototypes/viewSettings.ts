import type { PrototypeMode, PrototypeModel } from "./contracts";
import type {
  ProjectIndexOptions,
  IndexSourceId,
} from "../indexing/projectIndex";

export const SOURCES: { id: IndexSourceId; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "trackers", label: "Trackers" },
  { id: "git", label: "Commits" },
  { id: "plans", label: "Plans" },
  { id: "docs", label: "Documents" },
  { id: "github", label: "GitHub" },
  { id: "memory", label: "Memory" },
];
export interface ViewLens {
  id: string;
  name: string;
  mode: PrototypeMode;
  days: number;
  areaId: string | null;
  excludedTypes: string[];
  compare: boolean;
}
export interface ViewSettings {
  mode: PrototypeMode;
  days: number;
  areaId: string | null;
  excludedTypes: string[];
  compare: boolean;
  includeArchived: boolean;
  historyDays: number | null;
  sources: Partial<Record<IndexSourceId, boolean>>;
  safetyLimit: number | null;
  lenses: ViewLens[];
  lensId: string | null;
}
export const SETTINGS_KEY = "project-understanding.settings.v1";
export const REGISTRY_KEY = "project-understanding.areas.v1";
const modes = ["atlas", "pulse", "trails"];
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
export function normalizeSettings(raw: unknown): ViewSettings {
  const s =
    raw && typeof raw === "object" ? (raw as Partial<ViewSettings>) : {};
  return {
    mode: modes.includes(s.mode ?? "") ? s.mode! : "pulse",
    days: [7, 30, 90].includes(s.days ?? 0) ? s.days! : 7,
    areaId: typeof s.areaId === "string" ? s.areaId : null,
    excludedTypes: strings(s.excludedTypes),
    compare: s.compare === true,
    includeArchived: s.includeArchived !== false,
    historyDays:
      s.historyDays === null
        ? null
        : [90, 365].includes(s.historyDays ?? 0)
        ? s.historyDays!
        : 90,
    sources: Object.fromEntries(
      SOURCES.map(({ id }) => [id, s.sources?.[id] !== false])
    ),
    safetyLimit:
      typeof s.safetyLimit === "number" &&
      Number.isInteger(s.safetyLimit) &&
      s.safetyLimit >= 100
        ? s.safetyLimit
        : null,
    lenses: Array.isArray(s.lenses)
      ? s.lenses
          .filter(
            (l) =>
              l &&
              typeof l.id === "string" &&
              typeof l.name === "string" &&
              modes.includes(l.mode) &&
              [7, 30, 90].includes(l.days)
          )
          .slice(0, 30)
          .map((l) => ({
            ...l,
            areaId: typeof l.areaId === "string" ? l.areaId : null,
            excludedTypes: strings(l.excludedTypes),
            compare: l.compare === true,
          }))
      : [],
    lensId: typeof s.lensId === "string" ? s.lensId : null,
  };
}
export function indexOptions(
  s: ViewSettings,
  minimumDays = 0
): ProjectIndexOptions {
  return {
    sources: s.sources,
    includeArchived: s.includeArchived,
    historyHorizonMs:
      s.historyDays == null
        ? null
        : Math.max(s.historyDays, minimumDays) * 86400000,
    safetyMax:
      s.safetyLimit == null
        ? {}
        : Object.fromEntries(SOURCES.map(({ id }) => [id, s.safetyLimit])),
  };
}
export function lensMatches(s: ViewSettings, l: ViewLens): boolean {
  return (
    s.mode === l.mode &&
    s.days === l.days &&
    s.areaId === l.areaId &&
    s.compare === l.compare &&
    [...s.excludedTypes].sort().join("\0") ===
      [...l.excludedTypes].sort().join("\0")
  );
}
/** Filter the projection, never the index or the persistent area registry. */
export function scopeModel(
  model: PrototypeModel,
  excludedTypes: string[]
): PrototypeModel {
  if (!excludedTypes.length) return model;
  const excluded = new Set(excludedTypes);
  const nodes = model.snapshot.nodes.filter((n) => !excluded.has(n.type));
  const ids = new Set(nodes.map((n) => n.id));
  // Retain references to unloaded/filtered context; Trails names the boundary.
  const edges = model.snapshot.edges.filter(
    (e) => ids.has(e.sourceId) || ids.has(e.targetId)
  );
  const countsByType: Record<string, number> = {};
  for (const n of nodes) countsByType[n.type] = (countsByType[n.type] ?? 0) + 1;
  return {
    ...model,
    snapshot: {
      ...model.snapshot,
      nodes,
      edges,
      stats: { nodeCount: nodes.length, edgeCount: edges.length, countsByType },
    },
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    events: model.events.filter((e) => ids.has(e.nodeId)),
    areas: model.areas.map((a) => ({
      ...a,
      nodeIds: a.nodeIds.filter((id) => ids.has(id)),
    })),
    memberships: new Map([...model.memberships].filter(([id]) => ids.has(id))),
    coverage: [
      ...model.coverage,
      `${excludedTypes.length} item types hidden by the current view filter; the index retains their records.`,
    ],
  };
}
