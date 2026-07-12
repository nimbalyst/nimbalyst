/**
 * Layout Engine for Excalidraw
 *
 * Handles automatic positioning of elements in diagrams.
 * Supports multiple layout algorithms and incremental placement.
 */

import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import type { LayoutOptions } from '../types';

interface LayoutNode {
  id: string;
  element: ExcalidrawElement;
  width: number;
  height: number;
  x: number;
  y: number;
  connections: string[]; // IDs of connected nodes
}

export class LayoutEngine {
  private nodes: Map<string, LayoutNode> = new Map();

  /**
   * Add elements to the layout graph
   */
  addElements(elements: readonly ExcalidrawElement[]) {
    this.nodes.clear();

    for (const element of elements) {
      if (element.type === 'arrow') continue; // Skip arrows for now

      this.nodes.set(element.id, {
        id: element.id,
        element,
        width: element.width || 150,
        height: element.height || 80,
        x: element.x || 0,
        y: element.y || 0,
        connections: [],
      });
    }

    // Extract connections from arrows
    for (const element of elements) {
      if (element.type === 'arrow') {
        const start = (element as any).startBinding?.elementId;
        const end = (element as any).endBinding?.elementId;

        if (start && this.nodes.has(start)) {
          const node = this.nodes.get(start)!;
          if (end && !node.connections.includes(end)) {
            node.connections.push(end);
          }
        }
      }
    }
  }

  /**
   * Calculate optimal position for a new element near an existing one
   */
  calculateNearPosition(
    nearElementId: string,
    newWidth: number,
    newHeight: number
  ): { x: number; y: number } {
    const nearNode = this.nodes.get(nearElementId);
    if (!nearNode) {
      return this.calculateDefaultPosition(newWidth, newHeight);
    }

    const spacing = 100;

    // Try positions: right, below, left, above
    const candidates = [
      { x: nearNode.x + nearNode.width + spacing, y: nearNode.y },
      { x: nearNode.x, y: nearNode.y + nearNode.height + spacing },
      { x: nearNode.x - newWidth - spacing, y: nearNode.y },
      { x: nearNode.x, y: nearNode.y - newHeight - spacing },
    ];

    // Find first position that doesn't overlap
    for (const pos of candidates) {
      if (!this.hasOverlap(pos.x, pos.y, newWidth, newHeight)) {
        return pos;
      }
    }

    // Fallback: place to the right with extra offset
    return {
      x: nearNode.x + nearNode.width + spacing,
      y: nearNode.y,
    };
  }

  /**
   * Calculate default position when no reference element is given
   */
  calculateDefaultPosition(_width: number, _height: number): { x: number; y: number } {
    if (this.nodes.size === 0) {
      return { x: 100, y: 100 };
    }

    // Find the rightmost element
    let maxX = 0;
    let maxY = 0;
    for (const node of this.nodes.values()) {
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y);
    }

    return {
      x: maxX + 100,
      y: maxY,
    };
  }

  /**
   * Check if a position would overlap with existing elements
   */
  private hasOverlap(x: number, y: number, width: number, height: number): boolean {
    const padding = 20;

    for (const node of this.nodes.values()) {
      const overlapX =
        x < node.x + node.width + padding &&
        x + width > node.x - padding;

      const overlapY =
        y < node.y + node.height + padding &&
        y + height > node.y - padding;

      if (overlapX && overlapY) {
        return true;
      }
    }

    return false;
  }

  /**
   * Run full layout on all elements
   */
  layout(options: LayoutOptions): Map<string, { x: number; y: number }> {
    switch (options.algorithm) {
      case 'hierarchical':
        return this.hierarchicalLayout(options);
      case 'force-directed':
        return this.forceDirectedLayout(options);
      case 'grid':
        return this.gridLayout(options);
      default:
        return new Map();
    }
  }

  /**
   * Hierarchical layout (suitable for flow diagrams)
   */
  private hierarchicalLayout(options: LayoutOptions): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();
    const spacing = options.spacing || 150;
    const direction = options.direction || 'TB'; // Top to bottom

    // Simple layer-based layout
    const layers: string[][] = [];
    const visited = new Set<string>();

    // Find root nodes (nodes with no incoming connections)
    const hasIncoming = new Set<string>();
    for (const node of this.nodes.values()) {
      for (const targetId of node.connections) {
        hasIncoming.add(targetId);
      }
    }

    const roots: string[] = [];
    for (const node of this.nodes.values()) {
      if (!hasIncoming.has(node.id)) {
        roots.push(node.id);
      }
    }

    // BFS to assign layers
    let currentLayer = roots.length > 0 ? roots : Array.from(this.nodes.keys()).slice(0, 1);
    layers.push(currentLayer);

    while (currentLayer.length > 0) {
      const nextLayer: string[] = [];

      for (const nodeId of currentLayer) {
        visited.add(nodeId);
        const node = this.nodes.get(nodeId);
        if (!node) continue;

        for (const targetId of node.connections) {
          if (!visited.has(targetId) && !nextLayer.includes(targetId)) {
            nextLayer.push(targetId);
          }
        }
      }

      if (nextLayer.length > 0) {
        layers.push(nextLayer);
      }
      currentLayer = nextLayer;
    }

    // Add unvisited nodes to the last layer
    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        if (layers.length === 0) {
          layers.push([]);
        }
        layers[layers.length - 1].push(nodeId);
      }
    }

    // Position nodes
    const isHorizontal = direction === 'LR' || direction === 'RL';
    const isReverse = direction === 'BT' || direction === 'RL';

    layers.forEach((layer, layerIndex) => {
      const actualLayerIndex = isReverse ? layers.length - 1 - layerIndex : layerIndex;

      layer.forEach((nodeId, indexInLayer) => {
        const node = this.nodes.get(nodeId);
        if (!node) return;

        const offsetInLayer = (indexInLayer - (layer.length - 1) / 2) * spacing;

        if (isHorizontal) {
          positions.set(nodeId, {
            x: actualLayerIndex * spacing + 100,
            y: offsetInLayer + 300,
          });
        } else {
          positions.set(nodeId, {
            x: offsetInLayer + 300,
            y: actualLayerIndex * spacing + 100,
          });
        }
      });
    });

    return positions;
  }

  /**
   * Force-directed layout (suitable for network diagrams)
   */
  private forceDirectedLayout(_options: LayoutOptions): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();

    // Initialize random positions
    const centerX = 400;
    const centerY = 300;
    const radius = 200;

    Array.from(this.nodes.keys()).forEach((nodeId, index) => {
      const angle = (index / this.nodes.size) * 2 * Math.PI;
      positions.set(nodeId, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      });
    });

    // Run force-directed simulation (simplified)
    const iterations = 50;
    const repulsionStrength = 50000;
    const attractionStrength = 0.01;
    const damping = 0.8;

    for (let iter = 0; iter < iterations; iter++) {
      const forces = new Map<string, { x: number; y: number }>();

      // Initialize forces
      for (const nodeId of this.nodes.keys()) {
        forces.set(nodeId, { x: 0, y: 0 });
      }

      // Repulsion between all pairs
      for (const id1 of this.nodes.keys()) {
        for (const id2 of this.nodes.keys()) {
          if (id1 === id2) continue;

          const pos1 = positions.get(id1)!;
          const pos2 = positions.get(id2)!;

          const dx = pos1.x - pos2.x;
          const dy = pos1.y - pos2.y;
          const distSq = dx * dx + dy * dy + 1; // Avoid division by zero
          const dist = Math.sqrt(distSq);

          const force = repulsionStrength / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const f1 = forces.get(id1)!;
          f1.x += fx;
          f1.y += fy;
        }
      }

      // Attraction along edges
      for (const [id1, node1] of this.nodes) {
        for (const id2 of node1.connections) {
          if (!positions.has(id2)) continue;

          const pos1 = positions.get(id1)!;
          const pos2 = positions.get(id2)!;

          const dx = pos2.x - pos1.x;
          const dy = pos2.y - pos1.y;

          const fx = dx * attractionStrength;
          const fy = dy * attractionStrength;

          const f1 = forces.get(id1)!;
          f1.x += fx;
          f1.y += fy;

          const f2 = forces.get(id2)!;
          f2.x -= fx;
          f2.y -= fy;
        }
      }

      // Apply forces
      for (const [nodeId, force] of forces) {
        const pos = positions.get(nodeId)!;
        pos.x += force.x * damping;
        pos.y += force.y * damping;
      }
    }

    return positions;
  }

  /**
   * Grid layout (simple uniform spacing)
   */
  private gridLayout(options: LayoutOptions): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();
    const spacing = options.spacing || 200;
    const cols = Math.ceil(Math.sqrt(this.nodes.size));

    Array.from(this.nodes.keys()).forEach((nodeId, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;

      positions.set(nodeId, {
        x: col * spacing + 100,
        y: row * spacing + 100,
      });
    });

    return positions;
  }

  /**
   * Calculate arrow points for connecting two elements
   */
  calculateArrowPoints(
    fromId: string,
    toId: string
  ): { startX: number; startY: number; endX: number; endY: number } | null {
    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);

    if (!fromNode || !toNode) {
      return null;
    }

    // Simple center-to-center connection
    const startX = fromNode.x + fromNode.width / 2;
    const startY = fromNode.y + fromNode.height / 2;
    const endX = toNode.x + toNode.width / 2;
    const endY = toNode.y + toNode.height / 2;

    return { startX, startY, endX, endY };
  }
}
