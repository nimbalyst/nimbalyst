import type { ProjectGraphEdge, ProjectGraphNode } from '../../../types';
import type { PrototypeArea, PrototypeEvent, PrototypeModel } from '../../contracts';

export function node(id: string, over: Partial<ProjectGraphNode> = {}): ProjectGraphNode {
  return {
    id,
    type: over.type ?? 'task',
    label: over.label ?? id,
    category: 'delivery',
    source: 'tracker',
    visibility: 'local',
    ...over,
  };
}

export function edge(
  id: string,
  sourceId: string,
  targetId: string,
  type: ProjectGraphEdge['type'] = 'implements',
  label?: string,
): ProjectGraphEdge {
  return { id, type, sourceId, targetId, label };
}

export function event(
  id: string,
  nodeId: string,
  at: number,
  over: Partial<PrototypeEvent> = {},
): PrototypeEvent {
  return {
    id,
    nodeId,
    at,
    kind: over.kind ?? 'commit',
    label: over.label ?? `${id} label`,
    provenance: over.provenance ?? 'recorded',
  };
}

export function area(id: string, label: string, nodeIds: string[], basis = `tag:${id}`): PrototypeArea {
  return { id, label, nodeIds, basis };
}

export function model(input: {
  nodes: ProjectGraphNode[];
  edges?: ProjectGraphEdge[];
  areas: PrototypeArea[];
  events?: PrototypeEvent[];
  coverage?: string[];
}): PrototypeModel {
  const nodes = input.nodes;
  const edges = input.edges ?? [];
  const memberships = new Map<string, Array<{ areaId: string; basis: string }>>();
  for (const a of input.areas) {
    for (const nodeId of a.nodeIds) {
      const list = memberships.get(nodeId) ?? [];
      list.push({ areaId: a.id, basis: a.basis });
      memberships.set(nodeId, list);
    }
  }
  return {
    snapshot: {
      generatedAt: 0,
      nodes,
      edges,
      stats: { nodeCount: nodes.length, edgeCount: edges.length, countsByType: {} },
    },
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    areas: input.areas,
    memberships,
    events: input.events ?? [],
    coverage: input.coverage ?? [],
    source: 'sample',
  };
}
