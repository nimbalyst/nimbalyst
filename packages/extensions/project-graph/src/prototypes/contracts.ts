import type { ProjectGraphNode, ProjectGraphSnapshot } from "../types";

export type PrototypeMode = "atlas" | "pulse" | "trails";
export interface PrototypeArea {
  id: string;
  /** Persisted ordinal: refresh must not repack existing territories. */
  slot?: number;
  label: string;
  /** All-time loaded membership; never scoped to the selected time window. */
  nodeIds: string[];
  basis: string;
}
export interface PrototypeEvent {
  id: string;
  nodeId: string;
  at: number;
  kind: "created" | "commit" | "status" | "last-activity";
  label: string;
  /** Last-activity is one observation, never an inferred interval. */
  provenance: "recorded" | "last-observed";
}
export interface PrototypeMembership {
  areaId: string;
  basis: string;
}
export interface PrototypeModel {
  snapshot: ProjectGraphSnapshot;
  nodeById: Map<string, ProjectGraphNode>;
  areas: PrototypeArea[];
  memberships: Map<string, PrototypeMembership[]>;
  events: PrototypeEvent[];
  /** Source limitations, shown by the shared shell and available to each view. */
  coverage: string[];
  source: "live" | "sample";
  periodCoverage?: {
    startMs: number;
    endMs: number;
    complete: boolean;
    reason?: string;
  };
}
export interface PrototypeRange {
  startMs: number;
  endMs: number;
}
export interface PrototypeViewProps {
  model: PrototypeModel;
  range: PrototypeRange;
  comparisonRange?: PrototypeRange;
  selectedAreaId: string | null;
  selectedNodeId: string | null;
  onSelectArea: (id: string | null) => void;
  onSelectNode: (id: string | null) => void;
  onOpenNode: (node: ProjectGraphNode) => void;
  onResolveNode?: (id: string) => void;
  onNavigate: (mode: PrototypeMode, nodeId?: string, areaId?: string) => void;
  /** View-only display-name override; never changes source tags or records. */
  onRenameArea: (id: string, label: string) => void;
}
export function eventsInRange(
  model: PrototypeModel,
  range: PrototypeRange
): PrototypeEvent[] {
  return model.events.filter(
    (e) => e.at >= range.startMs && e.at <= range.endMs
  );
}
