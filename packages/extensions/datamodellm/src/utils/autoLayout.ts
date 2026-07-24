/**
 * Auto-Layout Algorithm for Data Model Entities
 *
 * Uses ELK (Eclipse Layout Kernel) for high-quality layered graph layout.
 * ELK handles edge crossing minimization, proper spacing, and variable node sizes.
 */

import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Entity, EntityViewMode, Relationship } from '../types';

const elk = new ELK();

/**
 * Estimate the rendered dimensions of an entity node based on view mode and field count.
 */
function estimateEntitySize(
  entity: Entity,
  viewMode: EntityViewMode
): { width: number; height: number } {
  if (viewMode === 'compact') {
    // Compact: name + field count badge + optional description line
    const baseHeight = 52;
    const descHeight = entity.description ? 24 : 0;
    return { width: 220, height: baseHeight + descHeight };
  }

  // Standard/full: header + field rows
  const headerHeight = 44;
  const fieldHeight = viewMode === 'full' ? 38 : 32;
  const padding = 16;
  const descHeight = viewMode === 'full' && entity.description ? 28 : 0;
  const fieldsHeight = Math.max(1, entity.fields.length) * fieldHeight;

  return {
    width: 300,
    height: headerHeight + fieldsHeight + descHeight + padding,
  };
}

/**
 * Auto-layout all entities considering relationships using ELK.
 */
export async function autoLayoutEntitiesAsync(
  entities: Entity[],
  relationships: Relationship[],
  viewMode: EntityViewMode = 'standard'
): Promise<Map<string, { x: number; y: number }>> {
  const positions = new Map<string, { x: number; y: number }>();

  if (entities.length === 0) {
    return positions;
  }

  const nameToId = new Map(entities.map((e) => [e.name, e.id]));

  const children: ElkNode[] = entities.map((entity) => {
    const size = estimateEntitySize(entity, viewMode);
    return {
      id: entity.id,
      width: size.width,
      height: size.height,
    };
  });

  const edges = relationships
    .map((rel, i) => {
      const sourceId = nameToId.get(rel.sourceEntityName);
      const targetId = nameToId.get(rel.targetEntityName);
      if (!sourceId || !targetId) return null;
      return { id: `e${i}`, sources: [sourceId], targets: [targetId] };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const nodeSpacing = viewMode === 'compact' ? '60' : '80';
  const layerSpacing = viewMode === 'compact' ? '100' : '140';

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': nodeSpacing,
      'elk.layered.spacing.nodeNodeBetweenLayers': layerSpacing,
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '120',
      'elk.padding': '[top=50,left=50,bottom=50,right=50]',
      // Improve compactness
      'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
    },
    children,
    edges,
  };

  const layoutResult = await elk.layout(graph);

  for (const node of layoutResult.children || []) {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }

  return positions;
}
